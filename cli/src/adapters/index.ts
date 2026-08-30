/**
 * Provider adapter interface + registry + shared failure classification.
 *
 * An adapter knows how to: log in to a subscription (OAuth/device flow),
 * refresh tokens, and build an AI SDK LanguageModelV3 whose fetch injects the
 * subscription credentials (and any request spoofing the provider requires).
 */

import type { LanguageModelV3 } from '@ai-sdk/provider'
import { APICallError } from '@ai-sdk/provider'
import * as errore from 'errore'
import { z } from 'zod'
import path from 'node:path'
import {
  isProviderId,
  readJson,
  subrouterHome,
  writeJson,
  type ProviderId,
  type StoredAccount,
} from '../store.ts'
import { anthropicAdapter } from './anthropic.ts'
import { alibabaAdapter, kimiAdapter, minimaxAdapter, zaiAdapter } from './coding-plans.ts'
import { githubCopilotAdapter } from './github-copilot.ts'
import { openaiAdapter } from './openai.ts'
export {
  closeOpenAIWebSockets,
  OPENAI_WEBSOCKET_SESSION_HEADER,
  OPENAI_WEBSOCKET_TITLE_HEADER,
} from './openai.ts'
import { opencodeGoAdapter } from './opencode-go.ts'
import { poeAdapter } from './poe.ts'
import { xaiAdapter } from './xai.ts'

export type PersistTokens = (update: Partial<StoredAccount>) => Promise<void>

export type LoginArgs = {
  /** log progress (auth URL, user code) to the user */
  log: (message: string) => void
  /** open a URL in the user's browser (best effort) */
  openUrl: (url: string, session: LoginSession) => Promise<void>
  /** ask the user to paste a code/redirect URL (interactive mode only) */
  promptManualInput?: () => Promise<string | null>
}

export type BeginLoginArgs = {
  /**
   * The authorizing browser is not on this machine, so a localhost callback
   * cannot be caught and the user must paste the redirect URL back. Harnesses
   * that drive login remotely (a chat bot, a web UI) set this.
   */
  manualInput?: boolean
  /** Provider-specific login method, such as `browser` or `device`. */
  method?: string
}

/**
 * A login started but not finished. Split in two halves so harnesses that
 * cannot block on a TTY (opencode's auth hook, and through it kimaki's Discord
 * `/login`) can show `url` + `instructions` first and call `complete` later.
 */
export type LoginSession = {
  /** URL the user must open to authorize */
  url: string
  /**
   * Human readable instructions. Device flows MUST embed the code as
   * `code: XXXX-XXXX` (uppercase alphanumeric + dashes) because harnesses
   * regex it out to render the code on its own. See openai/xai adapters.
   */
  instructions: string
  /** `auto` finishes on its own (device poll / localhost callback), `code` needs a pasted value */
  method: 'auto' | 'code'
  /** Safe to call more than once; adapters memoize the in-flight result. */
  complete(input?: string): Promise<Error | StoredAccount>
  /**
   * Abandon the login and release anything it holds (anthropic keeps a
   * localhost callback server listening). Safe to call after `complete`.
   */
  cancel?(): void
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
  /** Resolve the current API key or OAuth access token for native harness providers. */
  getApiKey(args: { account: StoredAccount; persist: PersistTokens }): Promise<Error | string>
  beginLogin(args?: BeginLoginArgs): Promise<Error | LoginSession>
}

export class LoginInputError extends errore.createTaggedError({
  name: 'LoginInputError',
  message: 'Login for $provider needs a pasted value but no input was available',
}) {}

/** Blocking one-shot login for TTY callers. The CLI uses this; opencode drives beginLogin directly. */
export async function runLogin({
  adapter,
  beginLoginArgs,
  log,
  openUrl,
  promptManualInput,
}: LoginArgs & { adapter: ProviderAdapter; beginLoginArgs?: BeginLoginArgs }): Promise<Error | StoredAccount> {
  const session = await adapter.beginLogin({
    ...beginLoginArgs,
    manualInput: beginLoginArgs?.manualInput ?? Boolean(process.env.SUBROUTER_MANUAL_OAUTH),
  })
  if (session instanceof Error) return session

  log(session.instructions)
  log(session.url)
  await openUrl(session.url, session)

  if (session.method === 'auto') return session.complete()

  if (!promptManualInput) return new LoginInputError({ provider: adapter.id })
  const input = await promptManualInput()
  if (!input?.trim()) return new LoginInputError({ provider: adapter.id })
  return session.complete(input.trim())
}

export const adapters: Record<ProviderId, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  xai: xaiAdapter,
  'opencode-go': opencodeGoAdapter,
  'github-copilot': githubCopilotAdapter,
  poe: poeAdapter,
  minimax: minimaxAdapter,
  kimi: kimiAdapter,
  zai: zaiAdapter,
  alibaba: alibabaAdapter,
}

export class ModelsDevError extends errore.createTaggedError({
  name: 'ModelsDevError',
  message: 'Could not load model IDs from models.dev: $reason',
}) {}

export class InvalidModelError extends errore.createTaggedError({
  name: 'InvalidModelError',
  message: 'Model $entry is not available as a text-output language model in models.dev',
}) {}

const modelsDevLimitSchema = z.object({
  context: z.number().optional(),
  output: z.number().optional(),
})

const modelsDevModelSchema = z.object({
  id: z.string(),
  modalities: z
    .object({
      output: z.array(z.string()).optional(),
    })
    .optional(),
  limit: modelsDevLimitSchema.optional(),
})

export type ModelsDevLimit = {
  context: number
  output: number
}

function catalogLimit(model: z.infer<typeof modelsDevModelSchema>): ModelsDevLimit | null {
  const context = model.limit?.context
  const output = model.limit?.output
  if (typeof context !== 'number' || typeof output !== 'number') return null
  return { context, output }
}

const MODELS_DEV_PROVIDER_KEYS = [
  'anthropic',
  'openai',
  'xai',
  'opencode-go',
  'github-copilot',
  'poe',
  'minimax-coding-plan',
  'kimi-for-coding',
  'zai-coding-plan',
  'alibaba-coding-plan',
] as const

const CATALOG_TTL_MS = 24 * 60 * 60 * 1000

function catalogCachePath() {
  return path.join(subrouterHome(), 'models-dev.json')
}

function trimModelsDevPayload(payload: object) {
  const source = Object.fromEntries(Object.entries(payload))
  return Object.fromEntries(
    MODELS_DEV_PROVIDER_KEYS.map((key) => {
      const provider = source[key]
      if (provider && typeof provider === 'object') return [key, provider]
      return [key, { models: {} }]
    }),
  )
}

const modelsDevProviderSchema = z
  .object({ models: z.record(z.string(), modelsDevModelSchema) })
  .transform(({ models }) => {
    const catalog = new Map<string, ModelsDevLimit | null>()
    for (const [modelId, model] of Object.entries(models)) {
      if (!model.modalities?.output?.includes('text')) continue
      catalog.set(modelId, catalogLimit(model))
    }
    return catalog
  })

const modelsDevCatalogSchema = z
  .object({
    anthropic: modelsDevProviderSchema,
    openai: modelsDevProviderSchema,
    xai: modelsDevProviderSchema,
    'opencode-go': modelsDevProviderSchema,
    'github-copilot': modelsDevProviderSchema,
    poe: modelsDevProviderSchema,
    'minimax-coding-plan': modelsDevProviderSchema,
    'kimi-for-coding': modelsDevProviderSchema,
    'zai-coding-plan': modelsDevProviderSchema,
    'alibaba-coding-plan': modelsDevProviderSchema,
  })
  .transform((catalog) => ({
    anthropic: catalog.anthropic,
    openai: catalog.openai,
    xai: catalog.xai,
    'opencode-go': catalog['opencode-go'],
    'github-copilot': catalog['github-copilot'],
    poe: catalog.poe,
    minimax: catalog['minimax-coding-plan'],
    kimi: catalog['kimi-for-coding'],
    zai: catalog['zai-coding-plan'],
    alibaba: catalog['alibaba-coding-plan'],
  }))

export type ModelsDevCatalog = z.infer<typeof modelsDevCatalogSchema>

export function parseModelsDevCatalog(payload: object): ModelsDevError | ModelsDevCatalog {
  const catalog = modelsDevCatalogSchema.safeParse(payload)
  if (!catalog.success) {
    return new ModelsDevError({ reason: 'invalid response shape', cause: catalog.error })
  }
  return catalog.data
}

export function modelsDevLimit({
  provider,
  modelId,
  catalog,
}: {
  provider: ProviderId
  modelId: string
  catalog: ModelsDevCatalog | Error
}) {
  if (catalog instanceof Error) return null
  return catalog[provider].get(modelId) ?? null
}

async function fetchModelsDevPayload() {
  // Tests point this at a local server. Never hit models.dev from a unit test.
  const url = modelsDevUrl()
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
  }).catch((cause) => new ModelsDevError({ reason: 'request failed', cause }))
  if (response instanceof Error) return response
  if (!response.ok) return new ModelsDevError({ reason: `HTTP ${response.status}` })

  const payload = await response.json().catch(
    (cause) => new ModelsDevError({ reason: 'invalid JSON response', cause }),
  )
  if (payload instanceof Error) return payload
  if (!payload || typeof payload !== 'object') {
    return new ModelsDevError({ reason: 'invalid response shape' })
  }
  return payload
}

function modelsDevUrl() {
  return process.env.SUBROUTER_MODELS_DEV_URL ?? 'https://models.dev/api.json'
}

export async function loadModelsDevCatalog() {
  const url = modelsDevUrl()
  const cached = await readJson<{ fetchedAt: number; url: string; payload: object } | null>(
    catalogCachePath(),
    null,
  )
  if (cached && cached.url === url && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) {
    const parsed = parseModelsDevCatalog(cached.payload)
    if (!(parsed instanceof Error)) return parsed
  }

  const payload = await fetchModelsDevPayload()
  if (payload instanceof Error) {
    if (!cached || cached.url !== url) return payload
    return parseModelsDevCatalog(cached.payload)
  }

  const trimmed = trimModelsDevPayload(payload)
  const cachedWrite = await writeJson(catalogCachePath(), {
    fetchedAt: Date.now(),
    url,
    payload: trimmed,
  }).catch((cause) => new ModelsDevError({ reason: 'cache write failed', cause }))
  if (cachedWrite instanceof Error) {
    console.warn(cachedWrite.message)
  }
  return parseModelsDevCatalog(trimmed)
}

export function validateModelsDevModelIds({
  entries,
  catalog,
}: {
  entries: string[]
  catalog: ModelsDevCatalog
}) {
  for (const entry of entries) {
    const slash = entry.indexOf('/')
    const provider = entry.slice(0, slash)
    const model = entry.slice(slash + 1)
    if (!isProviderId(provider)) return new InvalidModelError({ entry })

    if (!catalog[provider].has(model)) return new InvalidModelError({ entry })
  }
  return null
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

/**
 * Instructions for a browser login that finishes on a localhost callback.
 *
 * The callback server accepts any GET, so a redirect URL captured in a browser
 * that cannot reach this process can simply be replayed with curl. Harnesses
 * print `instructions` verbatim, and this rescue path is the difference between
 * a lost login and a finished one, so it is spelled out here rather than left
 * as folklore. It only works while the login is still running: the server lives
 * in that process and closes with it.
 */
export function callbackLoginInstructions({
  subscription,
  redirectUri,
}: {
  subscription: string
  redirectUri: string
}) {
  return [
    `Authorize ${subscription} in your browser. The localhost callback completes the login automatically.`,
    'If the browser cannot reach this machine, copy the final redirect URL from the address bar and replay it while this login is still running:',
    `curl '${redirectUri}?code=...&state=...'`,
    'Run curl on the machine that started the login. The redirect URL contains a one-time credential; do not paste it into a shared chat.',
  ].join('\n')
}

// --- Failure classification ---

export type FailureAction = {
  /** switch to the next account/provider */
  rotate: boolean
  /** how long to keep this account out of the pool */
  cooldownMs: number
}

export type FailureDetails = {
  statusCode?: number
  headers?: Record<string, string>
  message: string
  body?: string
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
    haystack.includes('refresh token expired') ||
    haystack.includes('re-login required') ||
    haystack.includes('invalid api key') ||
    haystack.includes('authentication_error') ||
    haystack.includes('permission_error')
  )
}

function quotaExhaustedText(text: string) {
  const haystack = text.toLowerCase()
  return (
    haystack.includes('quota has been exhausted') ||
    haystack.includes('quota exhausted') ||
    haystack.includes('quota exceeded') ||
    haystack.includes('insufficient_quota')
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
export function failureDetailsFromError(error: Error): FailureDetails {
  if (APICallError.isInstance(error)) {
    return {
      statusCode: error.statusCode,
      headers: error.responseHeaders,
      message: error.message,
      body: error.responseBody,
    }
  }
  return { message: error instanceof Error ? error.message : String(error) }
}

export function classifyFailure({ statusCode: status, headers, message, body = '' }: FailureDetails): FailureAction | null {
  if (quotaExhaustedText(`${message} ${body}`)) {
    return { rotate: true, cooldownMs: EXHAUSTED_COOLDOWN_MS }
  }
  if (status === 402) return { rotate: true, cooldownMs: EXHAUSTED_COOLDOWN_MS }
  if (status === 429) {
    const fromHeader = retryAfterMs(headers)
    return { rotate: true, cooldownMs: Math.max(fromHeader ?? 0, DEFAULT_COOLDOWN_MS) }
  }
  if (status === 401 || status === 403) return { rotate: true, cooldownMs: DEFAULT_COOLDOWN_MS }
  if (rotateWorthyText(`${message} ${body}`)) {
    return { rotate: true, cooldownMs: DEFAULT_COOLDOWN_MS }
  }
  return null
}

/** Permanent OAuth refresh death (invalid_grant / expired refresh). */
export function isPermanentRefreshFailure(error: Error | string) {
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
