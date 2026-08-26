/**
 * xAI Grok subscription adapter (SuperGrok / Grok Build).
 *
 * Uses the RFC 8628 device authorization flow against auth.x.ai with the
 * public Grok-CLI OAuth client, plus refresh-token rotation. The request
 * path just injects the OAuth bearer. Ported from opencode's bundled
 * XaiAuthPlugin (packages/opencode/src/plugin/xai.ts).
 */

import { createXai } from '@ai-sdk/xai'
import * as errore from 'errore'
import type { StoredAccount } from '../store.ts'
import {
  resolveBaseUrl,
  type LoginSession,
  type PersistTokens,
  type ProviderAdapter,
} from './index.ts'

export class XaiAuthError extends errore.createTaggedError({
  name: 'XaiAuthError',
  message: 'xAI auth failed: $reason',
}) {}

// Public Grok-CLI OAuth client, same one opencode reuses for desktop flows.
const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
const TOKEN_URL = 'https://auth.x.ai/oauth2/token'
const DEVICE_AUTHORIZATION_URL = 'https://auth.x.ai/oauth2/device/code'
const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'
const SCOPE = 'openid profile email offline_access grok-cli:access api:access'

const DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000
const DEVICE_CODE_MIN_INTERVAL_MS = 1_000
const DEVICE_CODE_SLOW_DOWN_INCREMENT_MS = 5_000
const DEVICE_CODE_DEFAULT_EXPIRES_MS = 5 * 60 * 1000
const POLL_SAFETY_MARGIN_MS = 3_000
const ACCESS_TOKEN_REFRESH_SKEW_MS = 120_000

function authHeaders() {
  return {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
    'User-Agent': 'subrouter',
  }
}

type TokenResponse = {
  access_token: string
  refresh_token: string
  expires_in?: number
}

/** Decode email/subject from a JWT access token without verifying it. */
export function extractXaiIdentity(accessToken: string): { email?: string; accountId?: string } {
  const parts = accessToken.split('.')
  if (parts.length < 2 || !parts[1]) return {}
  const claims = errore.try(
    () => JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>,
  )
  if (claims instanceof Error) return {}
  return {
    email: typeof claims.email === 'string' ? claims.email : undefined,
    accountId: typeof claims.sub === 'string' ? claims.sub : undefined,
  }
}

function accessTokenIsExpiring(token: string | undefined, skewMs = ACCESS_TOKEN_REFRESH_SKEW_MS) {
  if (!token) return false
  const parts = token.split('.')
  if (parts.length < 2 || !parts[1]) return false
  const claims = errore.try(
    () => JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { exp?: number },
  )
  if (claims instanceof Error) return false
  if (typeof claims.exp !== 'number') return false
  return claims.exp * 1000 <= Date.now() + Math.max(0, skewMs)
}

function positiveSecondsToMs(value: unknown, defaultMs: number) {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : defaultMs
}

async function sleep(ms: number) {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

// --- Device flow ---

type DeviceCodeResponse = {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in?: number
  interval?: number
}

async function requestDeviceCode(): Promise<XaiAuthError | DeviceCodeResponse> {
  const response = await fetch(DEVICE_AUTHORIZATION_URL, {
    method: 'POST',
    headers: authHeaders(),
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }).toString(),
  }).catch((e) => new XaiAuthError({ reason: 'device code request failed', cause: e }))
  if (response instanceof Error) return response
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    return new XaiAuthError({ reason: `device code request returned ${response.status}: ${detail}` })
  }
  const json = (await response.json().catch(() => null)) as DeviceCodeResponse | null
  if (!json?.device_code || !json.user_code || !json.verification_uri) {
    return new XaiAuthError({ reason: 'device code response missing required fields' })
  }
  return json
}

async function pollDeviceCodeToken(device: DeviceCodeResponse): Promise<XaiAuthError | TokenResponse> {
  const expiresInMs = positiveSecondsToMs(device.expires_in, DEVICE_CODE_DEFAULT_EXPIRES_MS)
  const deadline = Date.now() + expiresInMs
  let intervalMs = Math.max(
    positiveSecondsToMs(device.interval, DEVICE_CODE_DEFAULT_INTERVAL_MS),
    DEVICE_CODE_MIN_INTERVAL_MS,
  )

  while (Date.now() < deadline) {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: authHeaders(),
      body: new URLSearchParams({
        grant_type: DEVICE_CODE_GRANT_TYPE,
        client_id: CLIENT_ID,
        device_code: device.device_code,
      }).toString(),
    }).catch((e) => new XaiAuthError({ reason: 'device token poll failed', cause: e }))
    if (response instanceof Error) return response
    if (response.ok) return (await response.json()) as TokenResponse

    const body = (await response.json().catch(() => ({}))) as {
      error?: string
      error_description?: string
    }
    const remaining = Math.max(0, deadline - Date.now())
    if (body.error === 'authorization_pending') {
      await sleep(Math.min(intervalMs + POLL_SAFETY_MARGIN_MS, remaining))
      continue
    }
    if (body.error === 'slow_down') {
      intervalMs += DEVICE_CODE_SLOW_DOWN_INCREMENT_MS
      await sleep(Math.min(intervalMs + POLL_SAFETY_MARGIN_MS, remaining))
      continue
    }
    if (body.error === 'access_denied' || body.error === 'authorization_denied') {
      return new XaiAuthError({ reason: 'device authorization was denied' })
    }
    if (body.error === 'expired_token') {
      return new XaiAuthError({ reason: 'device code expired, re-run login' })
    }
    return new XaiAuthError({
      reason: `device token exchange failed (${response.status}): ${body.error_description ?? body.error ?? ''}`,
    })
  }
  return new XaiAuthError({ reason: 'device authorization timed out' })
}

async function beginLogin(): Promise<Error | LoginSession> {
  const device = await requestDeviceCode()
  if (device instanceof Error) return device

  let pending: Promise<Error | StoredAccount> | undefined

  return {
    url: device.verification_uri_complete ?? device.verification_uri,
    // The `code: X` shape is load bearing; harnesses regex it to show the code.
    instructions: `Open ${device.verification_uri} on any device and enter code: ${device.user_code}`,
    method: 'auto',
    complete() {
      pending ??= (async (): Promise<Error | StoredAccount> => {
        const tokens = await pollDeviceCodeToken(device)
        if (tokens instanceof Error) return tokens

        const identity = extractXaiIdentity(tokens.access_token)
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
      })()
      return pending
    },
  }
}

// --- Refresh + fetch ---

async function refreshXaiToken(refreshToken: string): Promise<XaiAuthError | TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: authHeaders(),
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  }).catch((e) => new XaiAuthError({ reason: 'token refresh failed', cause: e }))
  if (response instanceof Error) return response
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    return new XaiAuthError({ reason: `token refresh returned ${response.status}: ${detail}` })
  }
  return (await response.json()) as TokenResponse
}

const pendingRefresh = new Map<string, Promise<Error | { access: string; refresh: string; expires: number }>>()

async function freshAccessToken({
  account,
  persist,
}: {
  account: StoredAccount
  persist: PersistTokens
}): Promise<Error | string> {
  const expiresSoon =
    !account.expires ||
    account.expires - Date.now() <= ACCESS_TOKEN_REFRESH_SKEW_MS ||
    accessTokenIsExpiring(account.access)
  if (account.access && !expiresSoon) return account.access
  if (!account.refresh) return new XaiAuthError({ reason: 'account has no refresh token' })

  const refreshToken = account.refresh
  const pending = pendingRefresh.get(refreshToken)
  const promise =
    pending ??
    (async () => {
      const tokens = await refreshXaiToken(refreshToken)
      if (tokens instanceof Error) return tokens
      const refreshed = {
        access: tokens.access_token,
        refresh: tokens.refresh_token || refreshToken,
        expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
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

function buildFetch({ account, persist }: { account: StoredAccount; persist: PersistTokens }) {
  return async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const access = await freshAccessToken({ account, persist })
    if (access instanceof Error) throw access

    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => {
        headers.set(key, value)
      })
    }
    headers.set('authorization', `Bearer ${access}`)
    headers.set('user-agent', 'subrouter')
    return fetch(input, { ...init, headers })
  }
}

export const xaiAdapter: ProviderAdapter = {
  id: 'xai',
  name: 'xAI (SuperGrok / Grok Build)',
  defaultModels: ['grok-4.6', 'grok-4.5'],
  baseUrlEnvVar: 'SUBROUTER_XAI_BASE_URL',
  createModel({ modelId, account, persist }) {
    const provider = createXai({
      apiKey: 'subrouter-oauth',
      baseURL: resolveBaseUrl({
        envVar: this.baseUrlEnvVar,
        fallback: 'https://api.x.ai/v1',
      }),
      fetch: buildFetch({ account, persist }) as typeof fetch,
    })
    // opencode routes xai through the responses API; mirror that
    const withResponses = provider as typeof provider & {
      responses?: (modelId: string) => ReturnType<typeof provider.languageModel>
    }
    if (withResponses.responses) return withResponses.responses(modelId)
    return provider.languageModel(modelId)
  },
  beginLogin,
}
