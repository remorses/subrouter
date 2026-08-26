/**
 * OpenAI ChatGPT Plus/Pro subscription adapter (Codex backend).
 *
 * Login uses the Codex headless device flow against auth.openai.com. The
 * request path injects the OAuth bearer plus the ChatGPT-Account-Id header
 * and rewrites the API URL to the Codex responses endpoint at chatgpt.com.
 * Ported from opencode's bundled CodexAuthPlugin
 * (packages/opencode/src/plugin/openai/codex.ts).
 */

import { createOpenAI } from '@ai-sdk/openai'
import * as errore from 'errore'
import type { StoredAccount } from '../store.ts'
import { resolveBaseUrl, type LoginArgs, type PersistTokens, type ProviderAdapter } from './index.ts'

export class OpenAIAuthError extends errore.createTaggedError({
  name: 'OpenAIAuthError',
  message: 'OpenAI auth failed: $reason',
}) {}

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const ISSUER = 'https://auth.openai.com'
const CODEX_API_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'
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

// --- Login (Codex headless device flow) ---

async function login(args: LoginArgs): Promise<Error | StoredAccount> {
  const deviceResponse = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'subrouter' },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  }).catch((e) => new OpenAIAuthError({ reason: 'device authorization request failed', cause: e }))
  if (deviceResponse instanceof Error) return deviceResponse
  if (!deviceResponse.ok) {
    return new OpenAIAuthError({ reason: `device authorization returned ${deviceResponse.status}` })
  }

  const deviceData = (await deviceResponse.json()) as {
    device_auth_id: string
    user_code: string
    interval: string
  }
  const interval = Math.max(parseInt(deviceData.interval) || 5, 1) * 1000

  args.log(`Open ${ISSUER}/codex/device and enter code: ${deviceData.user_code}`)
  await args.openUrl(`${ISSUER}/codex/device`)

  const deadline = Date.now() + 10 * 60 * 1000
  while (Date.now() < deadline) {
    const response = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'subrouter' },
      body: JSON.stringify({
        device_auth_id: deviceData.device_auth_id,
        user_code: deviceData.user_code,
      }),
    }).catch((e) => new OpenAIAuthError({ reason: 'device token poll failed', cause: e }))
    if (response instanceof Error) return response

    if (response.ok) {
      const data = (await response.json()) as {
        authorization_code: string
        code_verifier: string
      }
      const tokenResponse = await fetch(`${ISSUER}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: data.authorization_code,
          redirect_uri: `${ISSUER}/deviceauth/callback`,
          client_id: CLIENT_ID,
          code_verifier: data.code_verifier,
        }).toString(),
      }).catch((e) => new OpenAIAuthError({ reason: 'token exchange failed', cause: e }))
      if (tokenResponse instanceof Error) return tokenResponse
      if (!tokenResponse.ok) {
        return new OpenAIAuthError({ reason: `token exchange returned ${tokenResponse.status}` })
      }
      const tokens = (await tokenResponse.json()) as TokenResponse
      const identity = extractOpenAIIdentity(tokens)
      const now = Date.now()
      return {
        type: 'oauth',
        refresh: tokens.refresh_token,
        access: tokens.access_token,
        expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
        email: identity.email,
        accountId: identity.accountId,
        addedAt: now,
        lastUsed: now,
      }
    }

    if (response.status !== 403 && response.status !== 404) {
      return new OpenAIAuthError({ reason: `device authorization failed (${response.status})` })
    }
    await sleep(interval + POLL_SAFETY_MARGIN_MS)
  }
  return new OpenAIAuthError({ reason: 'device authorization timed out' })
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
    const url =
      parsed.pathname.includes('/v1/responses') || parsed.pathname.includes('/chat/completions')
        ? new URL(codexEndpoint())
        : parsed

    return fetch(url, { ...init, headers })
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
  login,
}
