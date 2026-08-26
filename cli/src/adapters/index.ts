/**
 * Provider adapter interface + registry + shared failure classification.
 *
 * An adapter knows how to: log in to a subscription (OAuth/device flow),
 * refresh tokens, and build an AI SDK LanguageModelV3 whose fetch injects the
 * subscription credentials (and any request spoofing the provider requires).
 */

import type { LanguageModelV3 } from '@ai-sdk/provider'
import { APICallError } from '@ai-sdk/provider'
import type { ProviderId, StoredAccount } from '../store.ts'
import { anthropicAdapter } from './anthropic.ts'
import { openaiAdapter } from './openai.ts'
import { opencodeAdapter } from './opencode.ts'
import { xaiAdapter } from './xai.ts'

export type PersistTokens = (update: Partial<StoredAccount>) => Promise<void>

export type LoginArgs = {
  /** log progress (auth URL, user code) to the user */
  log: (message: string) => void
  /** open a URL in the user's browser (best effort) */
  openUrl: (url: string) => Promise<void>
  /** ask the user to paste a code/redirect URL (interactive mode only) */
  promptManualInput?: () => Promise<string | null>
}

export type ProviderAdapter = {
  id: ProviderId
  name: string
  /** ranked newest-first models, used to build the builtin default preset */
  defaultModels: string[]
  /** env var that overrides the API base URL (used by tests to fake servers) */
  baseUrlEnvVar: string
  createModel(args: {
    modelId: string
    account: StoredAccount
    persist: PersistTokens
  }): LanguageModelV3
  login(args: LoginArgs): Promise<Error | StoredAccount>
}

export const adapters: Record<ProviderId, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  xai: xaiAdapter,
  opencode: opencodeAdapter,
}

export function resolveBaseUrl({
  envVar,
  fallback,
}: {
  envVar: string
  fallback: string
}) {
  const override = process.env[envVar]
  if (override) return override.replace(/\/+$/, '')
  return fallback
}

// --- Failure classification ---

export type FailureAction = {
  /** switch to the next account/provider */
  rotate: boolean
  /** how long to keep this account out of the pool */
  cooldownMs: number
}

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000
const EXHAUSTED_COOLDOWN_MS = 6 * 60 * 60 * 1000

function rotateWorthyText(text: string) {
  const haystack = text.toLowerCase()
  return (
    haystack.includes('rate_limit') ||
    haystack.includes('rate limit') ||
    haystack.includes('usage limit') ||
    haystack.includes('usage_limit') ||
    haystack.includes('usage_not_included') ||
    haystack.includes('balance exhausted') ||
    haystack.includes('spending-limit') ||
    haystack.includes('run out of credits') ||
    haystack.includes('invalid api key') ||
    haystack.includes('authentication_error') ||
    haystack.includes('permission_error')
  )
}

function retryAfterMs(headers: Record<string, string> | undefined) {
  const raw = headers?.['retry-after']
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
  const date = Date.parse(raw)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return undefined
}

/**
 * Decide whether an error from a model call should trigger failover.
 * 402 means the subscription balance is exhausted (xAI Grok Build), which
 * gets a long cooldown. 429/401/403 and usage-limit texts get a short one.
 */
export function classifyFailure(error: unknown): FailureAction | null {
  if (!APICallError.isInstance(error)) {
    const message = error instanceof Error ? error.message : ''
    if (rotateWorthyText(message)) return { rotate: true, cooldownMs: DEFAULT_COOLDOWN_MS }
    return null
  }

  const status = error.statusCode
  const body = error.responseBody ?? ''
  if (status === 402) return { rotate: true, cooldownMs: EXHAUSTED_COOLDOWN_MS }
  if (status === 429) {
    const fromHeader = retryAfterMs(error.responseHeaders)
    return { rotate: true, cooldownMs: Math.max(fromHeader ?? 0, DEFAULT_COOLDOWN_MS) }
  }
  if (status === 401 || status === 403) return { rotate: true, cooldownMs: DEFAULT_COOLDOWN_MS }
  if (rotateWorthyText(`${error.message} ${body}`)) {
    return { rotate: true, cooldownMs: DEFAULT_COOLDOWN_MS }
  }
  return null
}

/** Permanent OAuth refresh death (invalid_grant / expired refresh). */
export function isPermanentRefreshFailure(error: unknown) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const haystack = message.toLowerCase()
  if (!haystack) return false
  if (haystack.includes('invalid_grant')) return true
  if (haystack.includes('refresh token expired')) return true
  if (haystack.includes('refresh_token') || haystack.includes('refresh token')) {
    return haystack.includes('expired') || haystack.includes('invalid') || haystack.includes('revoked')
  }
  return false
}
