/**
 * Anthropic Claude Pro/Max subscription adapter.
 *
 * OAuth PKCE flow against claude.ai plus the request spoofing the Anthropic
 * API requires to accept subscription (OAuth bearer) traffic: requests must
 * look like Claude Code CLI requests, so we rename tool names, prepend the
 * Claude Code identity to the system prompt, and send the claude-code beta
 * headers. Ported from kimaki's anthropic-auth-plugin.
 *
 * References:
 * - https://github.com/remorses/kimaki cli/src/anthropic-auth-plugin.ts
 * - https://github.com/badlogic/pi-mono packages/ai/src/utils/oauth/anthropic.ts
 */

import { createAnthropic } from '@ai-sdk/anthropic'
import * as errore from 'errore'
import { createServer, type Server } from 'node:http'
import type { StoredAccount } from '../store.ts'
import {
  callbackLoginInstructions,
  isPermanentRefreshFailure,
  resolveBaseUrl,
  type BeginLoginArgs,
  type LoginSession,
  type PersistTokens,
  type ProviderAdapter,
} from './index.ts'

export class AnthropicAuthError extends errore.createTaggedError({
  name: 'AnthropicAuthError',
  message: 'Anthropic auth failed: $reason',
}) {}

const CLIENT_ID = (() => {
  const encoded = 'OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl'
  return Buffer.from(encoded, 'base64').toString('utf8')
})()

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLIENT_DATA_URL = 'https://api.anthropic.com/api/oauth/claude_cli/client_data'
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
const CALLBACK_PORT = 53692
const CALLBACK_PATH = '/callback'
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`
const SCOPES =
  'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'
// 30 min: a login driven from a chat harness needs time for the human to see the
// URL, solve hCaptcha and approve. Under 5 min the callback server dies first.
const OAUTH_TIMEOUT_MS = 30 * 60 * 1000
const CLAUDE_CODE_VERSION = '2.1.75'
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."

const OPENCODE_IDENTITY = 'You are OpenCode, the best coding agent on the planet.'
const SUBAGENT_MODEL_IDENTITY = 'You are powered by the model named'
const ENV_CLOSE_TAG = '</env>'
const CLAUDE_CODE_BETA = 'claude-code-20250219'
const OAUTH_BETA = 'oauth-2025-04-20'
const FINE_GRAINED_TOOL_STREAMING_BETA = 'fine-grained-tool-streaming-2025-05-14'
const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14'

const OPENCODE_TO_CLAUDE_CODE_TOOL_NAME: Record<string, string> = {
  bash: 'Bash',
  edit: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  question: 'AskUserQuestion',
  read: 'Read',
  skill: 'Skill',
  task: 'Task',
  todowrite: 'TodoWrite',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  write: 'Write',
}

// --- PKCE ---

function base64urlEncode(bytes: Uint8Array) {
  return Buffer.from(bytes).toString('base64url')
}

async function generatePKCE() {
  const verifierBytes = new Uint8Array(32)
  crypto.getRandomValues(verifierBytes)
  const verifier = base64urlEncode(verifierBytes)
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: base64urlEncode(new Uint8Array(hash)) }
}

// --- Token exchange & refresh ---

type TokenData = { access_token: string; refresh_token: string; expires_in: number }

function tokenExpiry(expiresIn: number) {
  return Date.now() + expiresIn * 1000 - 5 * 60 * 1000
}

async function postTokenRequest(body: Record<string, string>): Promise<AnthropicAuthError | TokenData> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch((e) => new AnthropicAuthError({ reason: 'token request failed', cause: e }))
  if (response instanceof Error) return response
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    return new AnthropicAuthError({ reason: `token endpoint returned ${response.status}: ${text}` })
  }
  const parsed = errore.try(() => JSON.parse(text) as TokenData)
  if (parsed instanceof Error) {
    return new AnthropicAuthError({ reason: 'invalid token response', cause: parsed })
  }
  if (!parsed.access_token || !parsed.refresh_token) {
    return new AnthropicAuthError({ reason: `invalid token response: ${text}` })
  }
  return parsed
}

async function refreshAnthropicToken(refreshToken: string) {
  return postTokenRequest({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  })
}

async function fetchAccountIdentity(accessToken: string) {
  for (const url of [CLIENT_DATA_URL, PROFILE_URL]) {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
        'user-agent': `claude-cli/${CLAUDE_CODE_VERSION}`,
        'x-app': 'cli',
      },
    }).catch(() => null)
    if (!response || !response.ok) continue
    const parsed = (await response.json().catch(() => null)) as {
      account?: { email?: string; uuid?: string }
      email?: string
      uuid?: string
    } | null
    if (!parsed) continue
    const email = parsed.account?.email || parsed.email
    const accountId = parsed.account?.uuid || parsed.uuid
    if (email || accountId) return { email, accountId }
  }
  return undefined
}

// --- Login (localhost callback + manual paste fallback) ---

type CallbackResult = { code: string; state: string }

async function startCallbackServer(expectedState: string) {
  return new Promise<{
    server: Server
    cancelWait: () => void
    waitForCode: () => Promise<CallbackResult | null>
  }>((resolve, reject) => {
    let settle: ((value: CallbackResult | null) => void) | undefined
    let settled = false
    const waitPromise = new Promise<CallbackResult | null>((res) => {
      settle = (v) => {
        if (settled) return
        settled = true
        res(v)
      }
    })

    const server = createServer((req, res) => {
      const url = new URL(req.url || '', 'http://localhost')
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end('Not found')
        return
      }
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const error = url.searchParams.get('error')
      if (error || !code || !state || state !== expectedState) {
        res.writeHead(400).end('Authentication failed: ' + (error || 'missing code/state'))
        return
      }
      res
        .writeHead(200, { 'Content-Type': 'text/plain' })
        .end('Authentication successful. You can close this window.')
      settle?.({ code, state })
    })

    server.once('error', reject)
    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      resolve({
        server,
        cancelWait: () => {
          settle?.(null)
        },
        waitForCode: () => waitPromise,
      })
    })
  })
}

function parseManualInput(input: string): CallbackResult {
  const asUrl = errore.try(() => new URL(input))
  if (!(asUrl instanceof Error)) {
    const code = asUrl.searchParams.get('code')
    const state = asUrl.searchParams.get('state')
    if (code) return { code, state: state || '' }
  }
  if (input.includes('#')) {
    const [code = '', state = ''] = input.split('#', 2)
    return { code, state }
  }
  if (input.includes('code=')) {
    const params = new URLSearchParams(input)
    const code = params.get('code')
    if (code) return { code, state: params.get('state') || '' }
  }
  return { code: input, state: '' }
}

/**
 * Resolve the authorization code, from the localhost callback or from a value
 * the user pasted back. A pasted value still yields to the callback if that
 * already fired, because the callback carries the verified `state`.
 */
async function resolveCallbackResult({
  callbackServer,
  input,
}: {
  callbackServer: Awaited<ReturnType<typeof startCallbackServer>>
  input: string | undefined
}): Promise<AnthropicAuthError | CallbackResult> {
  try {
    const trimmed = input?.trim()
    if (trimmed) {
      const quick = await Promise.race([
        callbackServer.waitForCode(),
        new Promise<null>((r) => {
          setTimeout(() => {
            r(null)
          }, 50)
        }),
      ])
      if (quick?.code) return quick
      return parseManualInput(trimmed)
    }

    const result = await Promise.race([
      callbackServer.waitForCode(),
      new Promise<null>((r) => {
        setTimeout(() => {
          r(null)
        }, OAUTH_TIMEOUT_MS)
      }),
    ])
    if (!result?.code) {
      return new AnthropicAuthError({ reason: 'timed out waiting for OAuth callback' })
    }
    return result
  } finally {
    callbackServer.cancelWait()
    callbackServer.server.close()
  }
}

async function beginLogin(args?: BeginLoginArgs): Promise<Error | LoginSession> {
  const pkce = await generatePKCE()
  const callbackServer = args?.manualInput
    ? null
    : await startCallbackServer(pkce.verifier).catch(
        (e) => new AnthropicAuthError({ reason: 'failed to start callback server', cause: e }),
      )
  if (callbackServer instanceof Error) return callbackServer

  const authParams = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state: pkce.verifier,
  })

  let pending: Promise<Error | StoredAccount> | undefined

  return {
    url: `https://claude.ai/oauth/authorize?${authParams.toString()}`,
    instructions: args?.manualInput
      ? 'Authorize Claude Pro/Max in your browser, then paste the final redirect URL into this prompt, never a shared chat. Pasting just the authorization code also works.'
      : callbackLoginInstructions({ subscription: 'Claude Pro/Max', redirectUri: REDIRECT_URI }),
    method: args?.manualInput ? 'code' : 'auto',
    complete(input) {
      pending ??= (async () => {
        const trimmed = input?.trim()
        const result = callbackServer
          ? await resolveCallbackResult({ callbackServer, input })
          : trimmed
            ? parseManualInput(trimmed)
            : new AnthropicAuthError({ reason: 'no authorization code provided' })
        if (result instanceof Error) return result

        const tokens = await postTokenRequest({
          grant_type: 'authorization_code',
          client_id: CLIENT_ID,
          code: result.code,
          state: result.state || pkce.verifier,
          redirect_uri: REDIRECT_URI,
          code_verifier: pkce.verifier,
        })
        if (tokens instanceof Error) return tokens

        const identity = await fetchAccountIdentity(tokens.access_token)
        const now = Date.now()
        return {
          type: 'oauth',
          refresh: tokens.refresh_token,
          access: tokens.access_token,
          expires: tokenExpiry(tokens.expires_in),
          email: identity?.email,
          accountId: identity?.accountId,
          addedAt: now,
          lastUsed: now,
        } satisfies StoredAccount
      })()
      return pending
    },
    cancel() {
      callbackServer?.cancelWait()
      callbackServer?.server.close()
    },
  }
}

// --- Request rewriting (Claude Code spoofing) ---

function toClaudeCodeToolName(name: string) {
  return OPENCODE_TO_CLAUDE_CODE_TOOL_NAME[name.toLowerCase()] ?? name
}

/**
 * Strips the OpenCode identity (or subagent identity) plus its <env> block and
 * re-injects a compact <environment> tag preserving the working directory.
 */
function sanitizeSystemText(text: string) {
  const replaceBlock = (startIdx: number) => {
    const envCloseIdx = text.indexOf(ENV_CLOSE_TAG, startIdx)
    if (envCloseIdx === -1) return text
    const endIdx = envCloseIdx + ENV_CLOSE_TAG.length
    const afterEnd = text[endIdx] === '\n' ? endIdx + 1 : endIdx
    const strippedBlock = text.slice(startIdx, afterEnd)
    const cwdMatch =
      strippedBlock.match(/Working directory:\s*(.+)/)?.[1]?.trim() ||
      strippedBlock.match(/<cwd>([^<]+)<\/cwd>/)?.[1]
    const cwd = cwdMatch || process.cwd()
    const envContext =
      `\n<environment>\n<cwd>${cwd}</cwd>\n</environment>\n` +
      `Read, write, and edit files under ${cwd}.\n\n`
    return text.slice(0, startIdx) + envContext + text.slice(afterEnd)
  }

  const startIdx = text.indexOf(OPENCODE_IDENTITY)
  if (startIdx !== -1) return replaceBlock(startIdx)
  const subagentIdx = text.indexOf(SUBAGENT_MODEL_IDENTITY)
  if (subagentIdx !== -1) return replaceBlock(subagentIdx)
  return text
}

function mapSystemTextPart(part: unknown): unknown {
  if (typeof part === 'string') {
    return { type: 'text', text: sanitizeSystemText(part) }
  }
  if (
    part &&
    typeof part === 'object' &&
    'type' in part &&
    part.type === 'text' &&
    'text' in part &&
    typeof part.text === 'string'
  ) {
    return { ...part, text: sanitizeSystemText(part.text) }
  }
  return part
}

function prependClaudeCodeIdentity(system: unknown) {
  const identityBlock = { type: 'text', text: CLAUDE_CODE_IDENTITY }
  if (typeof system === 'undefined') return [identityBlock]
  if (typeof system === 'string') {
    const sanitized = sanitizeSystemText(system)
    if (sanitized === CLAUDE_CODE_IDENTITY) return [identityBlock]
    return [identityBlock, { type: 'text', text: sanitized }]
  }
  if (!Array.isArray(system)) return [identityBlock, system]

  const sanitized = system.map((item) => mapSystemTextPart(item))
  const first = sanitized[0]
  if (
    first &&
    typeof first === 'object' &&
    'type' in first &&
    first.type === 'text' &&
    'text' in first &&
    first.text === CLAUDE_CODE_IDENTITY
  ) {
    return sanitized
  }
  return [identityBlock, ...sanitized]
}

export function rewriteRequestPayload(body: string | undefined) {
  const empty = { body, modelId: undefined as string | undefined, reverseToolNameMap: new Map<string, string>() }
  if (!body) return empty
  const payload = errore.try(() => JSON.parse(body) as Record<string, unknown>)
  if (payload instanceof Error) return empty

  const reverseToolNameMap = new Map<string, string>()
  const modelId = typeof payload.model === 'string' ? payload.model : undefined

  if (Array.isArray(payload.tools)) {
    payload.tools = payload.tools.map((tool) => {
      if (!tool || typeof tool !== 'object') return tool
      const name = (tool as { name?: unknown }).name
      if (typeof name !== 'string') return tool
      const mapped = toClaudeCodeToolName(name)
      reverseToolNameMap.set(mapped, name)
      return { ...(tool as Record<string, unknown>), name: mapped }
    })
  }

  payload.system = prependClaudeCodeIdentity(payload.system)

  if (
    payload.tool_choice &&
    typeof payload.tool_choice === 'object' &&
    (payload.tool_choice as { type?: unknown }).type === 'tool'
  ) {
    const name = (payload.tool_choice as { name?: unknown }).name
    if (typeof name === 'string') {
      payload.tool_choice = {
        ...(payload.tool_choice as Record<string, unknown>),
        name: toClaudeCodeToolName(name),
      }
    }
  }

  if (Array.isArray(payload.messages)) {
    payload.messages = payload.messages.map((message) => {
      if (!message || typeof message !== 'object') return message
      const content = (message as { content?: unknown }).content
      if (!Array.isArray(content)) return message
      return {
        ...(message as Record<string, unknown>),
        content: content.map((block) => {
          if (!block || typeof block !== 'object') return block
          const b = block as { type?: unknown; name?: unknown }
          if (b.type !== 'tool_use' || typeof b.name !== 'string') return block
          return { ...(block as Record<string, unknown>), name: toClaudeCodeToolName(b.name) }
        }),
      }
    })
  }

  return { body: JSON.stringify(payload), modelId, reverseToolNameMap }
}

function wrapResponseStream(response: Response, reverseToolNameMap: Map<string, string>) {
  if (!response.body || reverseToolNameMap.size === 0) return response

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let carry = ''

  const transform = (text: string) => {
    return text.replace(/"name"\s*:\s*"([^"]+)"/g, (full, name: string) => {
      const original = reverseToolNameMap.get(name)
      return original ? full.replace(`"${name}"`, `"${original}"`) : full
    })
  }

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) {
        const finalText = carry + decoder.decode()
        if (finalText) controller.enqueue(encoder.encode(transform(finalText)))
        controller.close()
        return
      }
      carry += decoder.decode(value, { stream: true })
      // Buffer 256 chars to avoid splitting JSON keys across chunks
      if (carry.length <= 256) return
      const output = carry.slice(0, -256)
      carry = carry.slice(-256)
      controller.enqueue(encoder.encode(transform(output)))
    },
    async cancel(reason) {
      await reader.cancel(reason)
    },
  })

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

function getRequiredBetas(modelId: string | undefined) {
  const betas = [CLAUDE_CODE_BETA, OAUTH_BETA, FINE_GRAINED_TOOL_STREAMING_BETA]
  const isAdaptive =
    modelId?.includes('opus-4-6') ||
    modelId?.includes('opus-4.6') ||
    modelId?.includes('sonnet-4-6') ||
    modelId?.includes('sonnet-4.6')
  if (!isAdaptive) betas.push(INTERLEAVED_THINKING_BETA)
  return betas
}

function mergeBetas(existing: string | null, required: string[]) {
  return [
    ...new Set([
      ...required,
      ...(existing || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ]),
  ].join(',')
}

// --- Token freshness ---

const pendingRefresh = new Map<string, Promise<Error | { access: string; refresh: string; expires: number }>>()

async function freshAccessToken({
  account,
  persist,
}: {
  account: StoredAccount
  persist: PersistTokens
}): Promise<Error | string> {
  if (account.access && account.expires && account.expires > Date.now()) return account.access
  if (!account.refresh) return new AnthropicAuthError({ reason: 'account has no refresh token' })

  const refreshToken = account.refresh
  const pending = pendingRefresh.get(refreshToken)
  const promise =
    pending ??
    (async () => {
      const tokens = await refreshAnthropicToken(refreshToken)
      if (tokens instanceof Error) {
        if (isPermanentRefreshFailure(tokens)) {
          return new AnthropicAuthError({ reason: 'refresh token expired, re-login required', cause: tokens })
        }
        return tokens
      }
      const refreshed = {
        access: tokens.access_token,
        refresh: tokens.refresh_token,
        expires: tokenExpiry(tokens.expires_in),
      }
      await persist(refreshed)
      return refreshed
    })().finally(() => {
      pendingRefresh.delete(refreshToken)
    })
  pendingRefresh.set(refreshToken, promise)

  const result = await promise
  if (result instanceof Error) return result
  account.access = result.access
  account.refresh = result.refresh
  account.expires = result.expires
  return result.access
}

// --- Model factory ---

function buildFetch({ account, persist }: { account: StoredAccount; persist: PersistTokens }) {
  return async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const originalBody =
      typeof init?.body === 'string'
        ? init.body
        : input instanceof Request
          ? await input
              .clone()
              .text()
              .catch(() => undefined)
          : undefined

    const rewritten = rewriteRequestPayload(originalBody)
    const betas = getRequiredBetas(rewritten.modelId)

    const access = await freshAccessToken({ account, persist })
    if (access instanceof Error) throw access

    const headers = new Headers(init?.headers)
    if (input instanceof Request) {
      input.headers.forEach((v, k) => {
        if (!headers.has(k)) headers.set(k, v)
      })
    }
    headers.set('accept', 'application/json')
    headers.set('anthropic-beta', mergeBetas(headers.get('anthropic-beta'), betas))
    headers.set('anthropic-dangerous-direct-browser-access', 'true')
    headers.set('authorization', `Bearer ${access}`)
    headers.set('user-agent', `claude-cli/${CLAUDE_CODE_VERSION}`)
    headers.set('x-app', 'cli')
    headers.delete('x-api-key')

    const response = await fetch(input, {
      ...(init ?? {}),
      body: rewritten.body,
      headers,
    })
    return wrapResponseStream(response, rewritten.reverseToolNameMap)
  }
}

export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',
  name: 'Anthropic (Claude Pro/Max)',
  defaultModels: ['claude-opus-4-6', 'claude-sonnet-4-6'],
  baseUrlEnvVar: 'SUBROUTER_ANTHROPIC_BASE_URL',
  createModel({ modelId, account, persist }) {
    const provider = createAnthropic({
      apiKey: 'subrouter-oauth',
      baseURL: resolveBaseUrl({
        envVar: this.baseUrlEnvVar,
        fallback: 'https://api.anthropic.com/v1',
      }),
      fetch: buildFetch({ account, persist }) as typeof fetch,
    })
    return provider.languageModel(modelId)
  },
  getApiKey: freshAccessToken,
  beginLogin,
}
