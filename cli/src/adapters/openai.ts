/**
 * OpenAI ChatGPT Plus/Pro subscription adapter (Codex backend).
 *
 * Login supports Codex browser PKCE and headless device flows against
 * auth.openai.com. The request path injects the OAuth bearer plus the
 * ChatGPT-Account-Id header and rewrites the API URL to the Codex responses
 * endpoint at chatgpt.com.
 * Ported from opencode's bundled CodexAuthPlugin
 * (packages/opencode/src/plugin/openai/codex.ts).
 */

import { createOpenAI } from '@ai-sdk/openai'
import * as errore from 'errore'
import { createServer } from 'node:http'
import type { StoredAccount } from '../store.ts'
import {
  resolveBaseUrl,
  type BeginLoginArgs,
  type LoginSession,
  type PersistTokens,
  type ProviderAdapter,
} from './index.ts'

export class OpenAIAuthError extends errore.createTaggedError({
  name: 'OpenAIAuthError',
  message: 'OpenAI auth failed: $reason',
}) {}

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const ISSUER = 'https://auth.openai.com'
const CODEX_API_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'
const OAUTH_PORT = 1455
const OAUTH_CALLBACK_PATH = '/auth/callback'
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000
const POLL_SAFETY_MARGIN_MS = 3_000

type TokenResponse = {
  id_token?: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

type IdTokenClaims = {
  chatgpt_account_id?: string
  organizations?: Array<{ id: string }>
  email?: string
  'https://api.openai.com/auth'?: { chatgpt_account_id?: string }
  'https://api.openai.com/profile'?: { email?: string }
}

function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[1]) return undefined
  const claims = errore.try(
    () => JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as IdTokenClaims,
  )
  if (claims instanceof Error) return undefined
  return claims
}

function extractAccountIdFromClaims(claims: IdTokenClaims) {
  return (
    claims.chatgpt_account_id ||
    claims['https://api.openai.com/auth']?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  )
}

export function extractOpenAIIdentity(tokens: TokenResponse): { email?: string; accountId?: string } {
  for (const token of [tokens.id_token, tokens.access_token]) {
    if (!token) continue
    const claims = parseJwtClaims(token)
    if (!claims) continue
    const email = claims.email || claims['https://api.openai.com/profile']?.email
    const accountId = extractAccountIdFromClaims(claims)
    if (email || accountId) return { email, accountId }
  }
  return {}
}

async function sleep(ms: number) {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

// --- Login ---

/** Auth host. Overridable so tests can point the device flow at a local server. */
function issuerUrl() {
  return resolveBaseUrl({ envVar: 'SUBROUTER_OPENAI_ISSUER_URL', fallback: ISSUER })
}

async function generatePKCE() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
  const verifier = Array.from(
    crypto.getRandomValues(new Uint8Array(43)),
    (byte) => chars[byte % chars.length],
  ).join('')
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: Buffer.from(hash).toString('base64url') }
}

export function buildOpenAIAuthorizeUrl({
  redirectUri,
  challenge,
  state,
  issuer = ISSUER,
}: {
  redirectUri: string
  challenge: string
  state: string
  issuer?: string
}) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'openid profile email offline_access',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: 'opencode',
  })
  return `${issuer}/oauth/authorize?${params.toString()}`
}

function accountFromTokens(tokens: TokenResponse): StoredAccount {
  const identity = extractOpenAIIdentity(tokens)
  const now = Date.now()
  return {
    type: 'oauth',
    refresh: tokens.refresh_token,
    access: tokens.access_token,
    expires: now + (tokens.expires_in ?? 3600) * 1000,
    email: identity.email,
    accountId: identity.accountId,
    addedAt: now,
    lastUsed: now,
  }
}

async function exchangeCode({
  code,
  redirectUri,
  verifier,
  issuer,
}: {
  code: string
  redirectUri: string
  verifier: string
  issuer: string
}) {
  const response = await fetch(`${issuer}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }).toString(),
  }).catch((e) => new OpenAIAuthError({ reason: 'token exchange failed', cause: e }))
  if (response instanceof Error) return response
  if (!response.ok) {
    return new OpenAIAuthError({ reason: `token exchange returned ${response.status}` })
  }
  return accountFromTokens((await response.json()) as TokenResponse)
}

async function startCallbackServer({ state }: { state: string }) {
  let settle: ((value: string | OpenAIAuthError) => void) | undefined
  const result = new Promise<string | OpenAIAuthError>((resolve) => {
    settle = resolve
  })
  const server = createServer((request, response) => {
    const url = new URL(request.url || '/', `http://localhost:${OAUTH_PORT}`)
    if (url.pathname !== OAUTH_CALLBACK_PATH) {
      response.writeHead(404).end('Not found')
      return
    }

    const error = url.searchParams.get('error_description') || url.searchParams.get('error')
    const code = url.searchParams.get('code')
    if (error) {
      settle?.(new OpenAIAuthError({ reason: error }))
      response.writeHead(400).end(`Authorization failed: ${error}`)
      return
    }
    if (!code || url.searchParams.get('state') !== state) {
      const reason = code ? 'invalid OAuth state' : 'missing authorization code'
      settle?.(new OpenAIAuthError({ reason }))
      response.writeHead(400).end(`Authorization failed: ${reason}`)
      return
    }

    settle?.(code)
    response.writeHead(200).end('Authorization successful. You can close this window.')
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(OAUTH_PORT, 'localhost', resolve)
  })
  return { server, waitForCode: () => result }
}

function codeFromManualInput({ input, state }: { input: string | undefined; state: string }) {
  const value = input?.trim()
  if (!value) return new OpenAIAuthError({ reason: 'no authorization code provided' })
  const parsed = errore.try(() => new URL(value))
  if (parsed instanceof Error) return value
  const error = parsed.searchParams.get('error_description') || parsed.searchParams.get('error')
  if (error) return new OpenAIAuthError({ reason: error })
  const callbackState = parsed.searchParams.get('state')
  if (callbackState && callbackState !== state) {
    return new OpenAIAuthError({ reason: 'invalid OAuth state' })
  }
  return parsed.searchParams.get('code') || new OpenAIAuthError({ reason: 'missing authorization code' })
}

type DeviceAuth = {
  device_auth_id: string
  user_code: string
  interval: string
}

async function pollDeviceToken({
  device,
  issuer,
}: {
  device: DeviceAuth
  issuer: string
}): Promise<Error | StoredAccount> {
  const interval = Math.max(parseInt(device.interval) || 5, 1) * 1000
  const deadline = Date.now() + 10 * 60 * 1000

  while (Date.now() < deadline) {
    const response = await fetch(`${issuer}/api/accounts/deviceauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'subrouter' },
      body: JSON.stringify({
        device_auth_id: device.device_auth_id,
        user_code: device.user_code,
      }),
    }).catch((e) => new OpenAIAuthError({ reason: 'device token poll failed', cause: e }))
    if (response instanceof Error) return response

    if (response.ok) {
      const data = (await response.json()) as {
        authorization_code: string
        code_verifier: string
      }
      return exchangeCode({
        code: data.authorization_code,
        redirectUri: `${issuer}/deviceauth/callback`,
        verifier: data.code_verifier,
        issuer,
      })
    }

    if (response.status !== 403 && response.status !== 404) {
      return new OpenAIAuthError({ reason: `device authorization failed (${response.status})` })
    }
    await sleep(interval + POLL_SAFETY_MARGIN_MS)
  }
  return new OpenAIAuthError({ reason: 'device authorization timed out' })
}

async function beginDeviceLogin(): Promise<Error | LoginSession> {
  const issuer = issuerUrl()
  const deviceResponse = await fetch(`${issuer}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'subrouter' },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  }).catch((e) => new OpenAIAuthError({ reason: 'device authorization request failed', cause: e }))
  if (deviceResponse instanceof Error) return deviceResponse
  if (!deviceResponse.ok) {
    return new OpenAIAuthError({ reason: `device authorization returned ${deviceResponse.status}` })
  }

  const device = (await deviceResponse.json()) as DeviceAuth
  let pending: Promise<Error | StoredAccount> | undefined

  return {
    url: `${issuer}/codex/device`,
    // The `code: X` shape is load bearing; harnesses regex it to show the code.
    instructions: `Open ${issuer}/codex/device and enter code: ${device.user_code}`,
    method: 'auto',
    complete() {
      pending ??= pollDeviceToken({ device, issuer })
      return pending
    },
  }
}

async function beginBrowserLogin(args?: BeginLoginArgs): Promise<Error | LoginSession> {
  const issuer = issuerUrl()
  const redirectUri = `http://localhost:${OAUTH_PORT}${OAUTH_CALLBACK_PATH}`
  const pkce = await generatePKCE()
  const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
  const callbackServer = args?.manualInput
    ? undefined
    : await startCallbackServer({ state }).catch(
        (e) => new OpenAIAuthError({ reason: 'failed to start callback server', cause: e }),
      )
  if (callbackServer instanceof Error) return callbackServer

  let pending: Promise<Error | StoredAccount> | undefined
  return {
    url: buildOpenAIAuthorizeUrl({
      redirectUri,
      challenge: pkce.challenge,
      state,
      issuer,
    }),
    instructions: args?.manualInput
      ? 'Authorize ChatGPT in your browser, then paste the final localhost redirect URL.'
      : 'Authorize ChatGPT in your browser. The localhost callback completes login automatically.',
    method: args?.manualInput ? 'code' : 'auto',
    complete(input) {
      pending ??= (async () => {
        const code = callbackServer
          ? await Promise.race([
              callbackServer.waitForCode(),
              new Promise<OpenAIAuthError>((resolve) => {
                const timeout = setTimeout(() => {
                  resolve(new OpenAIAuthError({ reason: 'OAuth callback timed out' }))
                }, OAUTH_TIMEOUT_MS)
                timeout.unref()
              }),
            ])
          : codeFromManualInput({ input, state })
        callbackServer?.server.close()
        if (code instanceof Error) return code
        return exchangeCode({ code, redirectUri, verifier: pkce.verifier, issuer })
      })()
      return pending
    },
    cancel() {
      callbackServer?.server.unref()
      callbackServer?.server.close()
    },
  }
}

// --- Refresh + fetch ---

async function refreshOpenAIToken(refreshToken: string): Promise<OpenAIAuthError | TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  }).catch((e) => new OpenAIAuthError({ reason: 'token refresh failed', cause: e }))
  if (response instanceof Error) return response
  if (!response.ok) {
    return new OpenAIAuthError({ reason: `token refresh returned ${response.status}` })
  }
  return (await response.json()) as TokenResponse
}

const pendingRefresh = new Map<
  string,
  Promise<Error | { access: string; refresh: string; expires: number; accountId?: string }>
>()

async function freshAccessToken({
  account,
  persist,
}: {
  account: StoredAccount
  persist: PersistTokens
}): Promise<Error | { access: string; accountId?: string }> {
  if (account.access && account.expires && account.expires > Date.now()) {
    return { access: account.access, accountId: account.accountId }
  }
  if (!account.refresh) return new OpenAIAuthError({ reason: 'account has no refresh token' })

  const refreshToken = account.refresh
  const pending = pendingRefresh.get(refreshToken)
  const promise =
    pending ??
    (async () => {
      const tokens = await refreshOpenAIToken(refreshToken)
      if (tokens instanceof Error) return tokens
      const identity = extractOpenAIIdentity(tokens)
      const refreshed = {
        access: tokens.access_token,
        refresh: tokens.refresh_token || refreshToken,
        expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
        accountId: identity.accountId || account.accountId,
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
  if (result.accountId) account.accountId = result.accountId
  return { access: result.access, accountId: result.accountId }
}

function codexEndpoint() {
  const override = process.env.SUBROUTER_OPENAI_BASE_URL
  if (override) return `${override.replace(/\/+$/, '')}/responses`
  return CODEX_API_ENDPOINT
}

/**
 * The Codex backend rejects requests unless `store` is false (it returns
 * `{"detail":"Store must be set to false"}`). opencode enforces this via
 * providerOptions at the harness level; we enforce it at the fetch layer so
 * subrouter works in any harness.
 */
function patchCodexBody(body: string | undefined) {
  if (typeof body !== 'string' || body.length === 0) return body
  const payload = errore.try(() => JSON.parse(body) as Record<string, unknown>)
  if (payload instanceof Error) return body
  payload.store = false
  // Codex rejects max_output_tokens ("Unsupported parameter"); the Codex CLI
  // never sends it and opencode drops it via chat.params for openai.
  delete payload.max_output_tokens
  return JSON.stringify(payload)
}

function buildFetch({ account, persist }: { account: StoredAccount; persist: PersistTokens }) {
  return async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const auth = await freshAccessToken({ account, persist })
    if (auth instanceof Error) throw auth

    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => {
        headers.set(key, value)
      })
    }
    headers.set('authorization', `Bearer ${auth.access}`)
    if (auth.accountId) headers.set('ChatGPT-Account-Id', auth.accountId)
    headers.set('originator', 'opencode')

    const parsed =
      input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url)
    const isModelCall =
      parsed.pathname.includes('/v1/responses') || parsed.pathname.includes('/chat/completions')
    const url = isModelCall ? new URL(codexEndpoint()) : parsed

    const originalBody =
      typeof init?.body === 'string'
        ? init.body
        : input instanceof Request
          ? await input
              .clone()
              .text()
              .catch(() => undefined)
          : undefined
    const body = isModelCall ? patchCodexBody(originalBody) : originalBody

    return fetch(url, { ...init, ...(body !== undefined ? { body } : {}), headers })
  }
}

export const openaiAdapter: ProviderAdapter = {
  id: 'openai',
  name: 'OpenAI (ChatGPT Plus/Pro via Codex)',
  defaultModels: ['gpt-5.5', 'gpt-5.4'],
  baseUrlEnvVar: 'SUBROUTER_OPENAI_BASE_URL',
  createModel({ modelId, account, persist }) {
    const provider = createOpenAI({
      apiKey: 'subrouter-oauth',
      baseURL: resolveBaseUrl({
        envVar: this.baseUrlEnvVar,
        fallback: 'https://api.openai.com/v1',
      }),
      fetch: buildFetch({ account, persist }) as typeof fetch,
    })
    return provider.responses(modelId)
  },
  async getApiKey(args) {
    const auth = await freshAccessToken(args)
    if (auth instanceof Error) return auth
    return auth.access
  },
  async beginLogin(args) {
    if (!args?.method || args.method === 'browser') return beginBrowserLogin(args)
    if (args.method === 'device') return beginDeviceLogin()
    return new OpenAIAuthError({ reason: `unknown login method ${args.method}` })
  },
}
