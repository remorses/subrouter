/** GitHub Copilot subscription adapter with device login and native API passthrough. */

import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import * as errore from 'errore'
import type { StoredAccount } from '../store.ts'
import { resolveBaseUrl, type LoginSession, type PersistTokens, type ProviderAdapter } from './index.ts'

export class GitHubCopilotAuthError extends errore.createTaggedError({
  name: 'GitHubCopilotAuthError',
  message: 'GitHub Copilot auth failed: $reason',
}) {}

const CLIENT_ID = 'Iv1.b507a08c87ecfe98'
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000

function githubUrl() {
  return resolveBaseUrl({
    envVar: 'SUBROUTER_GITHUB_COPILOT_GITHUB_URL',
    fallback: 'https://github.com',
  })
}

function githubApiUrl() {
  return resolveBaseUrl({
    envVar: 'SUBROUTER_GITHUB_COPILOT_GITHUB_API_URL',
    fallback: 'https://api.github.com',
  })
}

function copilotApiUrl() {
  return resolveBaseUrl({
    envVar: 'SUBROUTER_GITHUB_COPILOT_BASE_URL',
    fallback: 'https://api.individual.githubcopilot.com',
  })
}

function authHeaders() {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': 'subrouter',
  }
}

export function buildGitHubDeviceCodeBody() {
  return new URLSearchParams({ client_id: CLIENT_ID, scope: 'read:user' }).toString()
}

type DeviceCode = {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in?: number
  interval?: number
}

type CopilotToken = {
  token: string
  expires_at: number
}

async function requestDeviceCode(): Promise<Error | DeviceCode> {
  const response = await fetch(`${githubUrl()}/login/device/code`, {
    method: 'POST',
    headers: authHeaders(),
    body: buildGitHubDeviceCodeBody(),
  }).catch((cause) => new GitHubCopilotAuthError({ reason: 'device code request failed', cause }))
  if (response instanceof Error) return response
  if (!response.ok) return new GitHubCopilotAuthError({ reason: `device code request returned ${response.status}` })

  const device = (await response.json().catch(() => null)) as DeviceCode | null
  if (!device?.device_code || !device.user_code || !device.verification_uri) {
    return new GitHubCopilotAuthError({ reason: 'device code response missing required fields' })
  }
  return device
}

async function sleep(ms: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function pollGitHubToken(device: DeviceCode) {
  const deadline = Date.now() + (device.expires_in ?? 900) * 1000
  let intervalMs = Math.max(device.interval ?? 5, 1) * 1000

  while (Date.now() < deadline) {
    const response = await fetch(`${githubUrl()}/login/oauth/access_token`, {
      method: 'POST',
      headers: authHeaders(),
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        device_code: device.device_code,
        grant_type: DEVICE_GRANT_TYPE,
      }).toString(),
    }).catch((cause) => new GitHubCopilotAuthError({ reason: 'device token poll failed', cause }))
    if (response instanceof Error) return response

    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string
      error?: string
      error_description?: string
      interval?: number
    }
    if (response.ok && body.access_token) return body.access_token
    if (body.error === 'authorization_pending') {
      await sleep(intervalMs)
      continue
    }
    if (body.error === 'slow_down') {
      intervalMs += 5_000
      await sleep(intervalMs)
      continue
    }
    return new GitHubCopilotAuthError({
      reason: body.error_description ?? body.error ?? `device token poll returned ${response.status}`,
    })
  }
  return new GitHubCopilotAuthError({ reason: 'device authorization timed out' })
}

export function buildCopilotTokenRequest(githubToken: string): RequestInit {
  return {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${githubToken}`,
      'Copilot-Integration-Id': 'vscode-chat',
      'Editor-Plugin-Version': 'copilot-chat/0.35.0',
      'Editor-Version': 'vscode/1.107.0',
      'User-Agent': 'GitHubCopilotChat/0.35.0',
    },
  }
}

async function exchangeCopilotToken(githubToken: string): Promise<Error | CopilotToken> {
  const response = await fetch(
    `${githubApiUrl()}/copilot_internal/v2/token`,
    buildCopilotTokenRequest(githubToken),
  ).catch((cause) => new GitHubCopilotAuthError({ reason: 'Copilot token exchange failed', cause }))
  if (response instanceof Error) return response
  if (response.status === 401 || response.status === 403) {
    return new GitHubCopilotAuthError({ reason: 'GitHub token expired, re-login required' })
  }
  if (!response.ok) return new GitHubCopilotAuthError({ reason: `Copilot token exchange returned ${response.status}` })

  const token = (await response.json().catch(() => null)) as CopilotToken | null
  if (!token?.token || !token.expires_at) {
    return new GitHubCopilotAuthError({ reason: 'Copilot token response missing required fields' })
  }
  return token
}

async function beginLogin(): Promise<Error | LoginSession> {
  const device = await requestDeviceCode()
  if (device instanceof Error) return device
  let pending: Promise<Error | StoredAccount> | undefined

  return {
    url: device.verification_uri,
    instructions: `Open ${device.verification_uri} and enter code: ${device.user_code}`,
    method: 'auto',
    complete() {
      pending ??= (async () => {
        const githubToken = await pollGitHubToken(device)
        if (githubToken instanceof Error) return githubToken
        const copilotToken = await exchangeCopilotToken(githubToken)
        if (copilotToken instanceof Error) return copilotToken
        const now = Date.now()
        return {
          type: 'oauth',
          refresh: githubToken,
          access: copilotToken.token,
          expires: copilotToken.expires_at * 1000 - TOKEN_REFRESH_SKEW_MS,
          addedAt: now,
          lastUsed: now,
        } satisfies StoredAccount
      })()
      return pending
    },
  }
}

const pendingRefresh = new Map<string, Promise<Error | CopilotToken>>()

async function freshCopilotToken({
  account,
  persist,
}: {
  account: StoredAccount
  persist: PersistTokens
}) {
  if (account.access && account.expires && account.expires > Date.now()) return account.access
  if (!account.refresh) return new GitHubCopilotAuthError({ reason: 'account has no GitHub token' })

  const githubToken = account.refresh
  const existing = pendingRefresh.get(githubToken)
  const pending =
    existing ??
    exchangeCopilotToken(githubToken).finally(() => {
      pendingRefresh.delete(githubToken)
    })
  pendingRefresh.set(githubToken, pending)

  const token = await pending
  if (token instanceof Error) return token
  const expires = token.expires_at * 1000 - TOKEN_REFRESH_SKEW_MS
  account.access = token.token
  account.expires = expires
  await persist({ access: token.token, expires })
  return token.token
}

export function shouldUseCopilotResponses(modelId: string) {
  if (modelId.startsWith('grok-') || modelId.startsWith('mai-code-')) return true
  const match = /^gpt-(\d+)/.exec(modelId)
  if (!match) return false
  return Number(match[1]) >= 5
}

export function patchCopilotBody(body: string | undefined) {
  if (!body) return body
  const payload = errore.try(() => JSON.parse(body) as { tools?: Array<Record<string, unknown>> })
  if (payload instanceof Error || !Array.isArray(payload.tools)) return body
  payload.tools = payload.tools.map(({ eager_input_streaming: _, ...tool }) => tool)
  return JSON.stringify(payload)
}

function hasImage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasImage)
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (record.type === 'image' || record.type === 'image_url' || record.type === 'input_image') return true
  return Object.values(record).some(hasImage)
}

function requestTraits(body: string | undefined) {
  if (!body) return { isAgent: false, isVision: false }
  const payload = errore.try(() => JSON.parse(body) as Record<string, unknown>)
  if (payload instanceof Error) return { isAgent: false, isVision: false }
  const items = Array.isArray(payload.input)
    ? payload.input
    : Array.isArray(payload.messages)
      ? payload.messages
      : []
  const last = items.at(-1)
  const lastRecord = last && typeof last === 'object' ? (last as Record<string, unknown>) : undefined
  const content = Array.isArray(lastRecord?.content) ? lastRecord.content : []
  const hasUserContent =
    typeof lastRecord?.content === 'string' ||
    content.some((part) => {
      return !part || typeof part !== 'object' || (part as Record<string, unknown>).type !== 'tool_result'
    })
  return {
    isAgent: lastRecord?.role !== 'user' || !hasUserContent || hasImage(last),
    isVision: hasImage(items),
  }
}

function requestUrl(input: Request | string | URL, token: string) {
  const original = new URL(input instanceof URL ? input : typeof input === 'string' ? input : input.url)
  if (process.env.SUBROUTER_GITHUB_COPILOT_BASE_URL) return original
  const proxyHost = token.match(/proxy-ep=([^;]+)/)?.[1]
  if (!proxyHost) return original
  const apiHost = proxyHost.replace(/^proxy\./, 'api.')
  return new URL(`${original.pathname}${original.search}`, `https://${apiHost}`)
}

function buildFetch({ account, persist }: { account: StoredAccount; persist: PersistTokens }) {
  return async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const token = await freshCopilotToken({ account, persist })
    if (token instanceof Error) throw token

    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value))
    headers.set('authorization', `Bearer ${token}`)
    headers.set('copilot-integration-id', 'vscode-chat')
    headers.set('editor-plugin-version', 'copilot-chat/0.35.0')
    headers.set('editor-version', 'vscode/1.107.0')
    headers.set('openai-intent', 'conversation-edits')
    headers.set('user-agent', 'GitHubCopilotChat/0.35.0')
    headers.set('x-github-api-version', '2026-06-01')
    headers.delete('x-api-key')

    const originalBody =
      typeof init?.body === 'string'
        ? init.body
        : input instanceof Request
          ? await input.clone().text().catch(() => undefined)
          : undefined
    const traits = requestTraits(originalBody)
    headers.set('x-initiator', traits.isAgent ? 'agent' : 'user')
    if (traits.isVision) headers.set('copilot-vision-request', 'true')
    else headers.delete('copilot-vision-request')
    const url = requestUrl(input, token)
    const body = url.pathname.endsWith('/v1/messages') ? patchCopilotBody(originalBody) : originalBody
    return fetch(url, { ...init, ...(body !== undefined ? { body } : {}), headers })
  }
}

export const githubCopilotAdapter: ProviderAdapter = {
  id: 'github-copilot',
  name: 'GitHub Copilot',
  defaultModels: ['gpt-5.5', 'claude-opus-5'],
  baseUrlEnvVar: 'SUBROUTER_GITHUB_COPILOT_BASE_URL',
  createModel({ modelId, account, persist }) {
    const baseURL = copilotApiUrl()
    const customFetch = buildFetch({ account, persist }) as typeof fetch
    if (modelId.startsWith('claude-') && modelId !== 'claude-fable-5') {
      return createAnthropic({ apiKey: 'subrouter-oauth', baseURL: `${baseURL}/v1`, fetch: customFetch })
        .languageModel(modelId)
    }
    const provider = createOpenAI({ apiKey: 'subrouter-oauth', baseURL, fetch: customFetch })
    if (shouldUseCopilotResponses(modelId)) return provider.responses(modelId)
    return provider.chat(modelId)
  },
  getApiKey: freshCopilotToken,
  beginLogin,
}
