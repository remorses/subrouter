/**
 * The subrouter routing engine.
 *
 * A RouterModel is an AI SDK LanguageModelV3 whose modelId is a preset name.
 * On every call it resolves the preset to an ordered list of candidates
 * (provider/model plus one entry per logged-in account), skips accounts in
 * cooldown, filters out models that cannot accept the prompt modalities, and
 * delegates to the first usable underlying model. When a call fails with a
 * rate-limit/usage error, the account is put in cooldown
 * (globally, in ~/.subrouter/config.json) and the next candidate is tried.
 * A successful candidate stays first for later calls in the same agent run.
 * Cooling-down-only failures throw a retryable 429 so OpenCode waits
 * instead of dying. It only throws a hard error when nothing can be retried.
 * Cycle logs go through the log callback passed at construction, never
 * stdout. OpenCode wires that to client.app.log. Pi has no log API, so
 * those runs stay silent.
 *
 * doStream must return as soon as the HTTP stream exists. Waiting for the
 * first content token (old inspectStream) made Grok look hung for the whole
 * thinking window. Official OpenCode xAI has no such wait.
 */

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  JSONValue,
} from '@ai-sdk/provider'
import { APICallError, isJSONObject } from '@ai-sdk/provider'
import * as errore from 'errore'
import { randomUUID } from 'node:crypto'
import {
  adapters,
  classifyFailure,
  emitLog,
  failureDetailsFromError,
  loadModelsDevCatalog,
  modelsDevInputModalities,
  type ModelsDevCatalog,
  type SubrouterLog,
} from './adapters/index.ts'
import { OPENCODE_GO_SESSION_HEADER } from './adapters/opencode-go.ts'
import {
  OPENAI_WEBSOCKET_SESSION_HEADER,
  OPENAI_WEBSOCKET_TITLE_HEADER,
} from './adapters/openai-websocket.ts'

import {
  isCoolingDown,
  loadAccounts,
  loadPresets,
  loadState,
  markCooldown,
  getLiveRoute,
  setLiveRoute,
  updateAccount,
  accountLabel,
  cooldownKey,
  type ProviderId,
  type StoredAccount,
  isProviderId,
} from './store.ts'

export class PresetNotFoundError extends errore.createTaggedError({
  name: 'PresetNotFoundError',
  message: 'Preset $preset does not exist. Create it with: subrouter preset create $preset',
}) {}

export class NoUsableAccountError extends errore.createTaggedError({
  name: 'NoUsableAccountError',
  message: 'No usable account for preset $preset: $reason',
}) {}

export class AllCandidatesExhaustedError extends errore.createTaggedError({
  name: 'AllCandidatesExhaustedError',
  message: 'All subscriptions exhausted for preset $preset: $attempts',
}) {}

export const DEFAULT_PROVIDER_ORDER: ProviderId[] = [
  'anthropic',
  'openai',
  'xai',
  'opencode-go',
  'github-copilot',
  'poe',
  'minimax',
  'kimi',
  'zai',
  'alibaba',
]
export const DEFAULT_PRESET_NAME = 'default'
export const PROVIDER_ID = 'subrouter'
export const PROVIDER_DISPLAY_NAME = 'subrouter.org'
export const OPENCODE_AGENT_HEADER = 'x-subrouter-opencode-agent'
export const OPENCODE_VARIANT_HEADER = 'x-subrouter-opencode-variant'
export const ROUTE_AFFINITY_HEADER = 'x-subrouter-route-affinity'

/** Builtin default preset: newest model of each provider, ranked. */
export function builtinDefaultPreset() {
  return DEFAULT_PROVIDER_ORDER.map((provider) => {
    const model = adapters[provider].defaultModels[0]
    return `${provider}/${model}`
  })
}

/**
 * Resolve a preset name to its ordered `provider/model` entries.
 * User presets win; the `default` preset falls back to the builtin ranking.
 */
export async function resolvePresetModels(preset: string): Promise<PresetNotFoundError | string[]> {
  const presets = await loadPresets()
  const stored = presets.presets[preset]
  if (stored && stored.length > 0) return stored
  if (preset === DEFAULT_PRESET_NAME) return builtinDefaultPreset()
  return new PresetNotFoundError({ preset })
}

export type Candidate = {
  provider: ProviderId
  modelId: string
  account: StoredAccount
  accountIndex: number
}

export class RouteAffinity {
  private candidates = new Map<
    string,
    Pick<Candidate, 'provider' | 'modelId'> & { account: string }
  >()

  prioritize(key: string | null, candidates: Candidate[]) {
    if (!key) return candidates
    const affinity = this.candidates.get(key)
    if (!affinity) return candidates
    const index = candidates.findIndex(
      (candidate) =>
        candidate.provider === affinity.provider &&
        candidate.modelId === affinity.modelId &&
        cooldownKey(candidate) === affinity.account,
    )
    if (index <= 0) return candidates
    return [candidates[index]!, ...candidates.slice(0, index), ...candidates.slice(index + 1)]
  }

  select(key: string | null, candidate: Candidate) {
    if (!key) return
    this.candidates.set(key, {
      provider: candidate.provider,
      modelId: candidate.modelId,
      account: cooldownKey(candidate),
    })
  }

  clear(key: string) {
    if (!this.candidates.has(key)) return
    this.candidates.delete(key)
  }
}

export type CooldownFallbackNotice = {
  sessionID?: string
  agent?: string
  variant?: string
  preset: string
  preferred: {
    provider: ProviderId
    modelId: string
    retryAfterMs: number
  }
  active: {
    provider: ProviderId
    modelId: string
  }
}

type CoolingCandidate = Candidate & { until: number }

export type InputModality = 'text' | 'audio' | 'image' | 'video' | 'pdf'

function mediaTypeModality(mediaType: string): InputModality | null {
  if (mediaType === 'application/pdf') return 'pdf'
  const topLevel = mediaType.split('/', 1)[0]
  if (topLevel === 'audio' || topLevel === 'image' || topLevel === 'video') return topLevel
  return null
}

export function requiredInputModalities(options: LanguageModelV3CallOptions) {
  const required = new Set<InputModality>(['text'])
  for (const message of options.prompt) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part.type !== 'file') continue
      const modality = mediaTypeModality(part.mediaType)
      if (modality) required.add(modality)
    }
  }
  return required
}

export function filterPresetModelsByInput({
  presetModels,
  required,
  catalog,
}: {
  presetModels: string[]
  required: Set<InputModality>
  catalog: ModelsDevCatalog | Error
}) {
  if (catalog instanceof Error || required.size === 1) return { presetModels, skipped: [] }
  const compatible: string[] = []
  const skipped: string[] = []
  for (const entry of presetModels) {
    const slash = entry.indexOf('/')
    const provider = entry.slice(0, slash)
    const modelId = entry.slice(slash + 1)
    if (slash <= 0 || !isProviderId(provider)) {
      compatible.push(entry)
      continue
    }
    const input = modelsDevInputModalities({ provider, modelId, catalog })
    const missing = input ? [...required].filter((modality) => !input.includes(modality)) : []
    if (missing.length === 0) {
      compatible.push(entry)
      continue
    }
    skipped.push(`${entry}: does not support ${missing.join(', ')} input`)
  }
  return { presetModels: compatible, skipped }
}

/**
 * Expand preset entries into per-account candidates, skipping accounts in
 * cooldown. Accounts are tried starting from the pool's activeIndex.
 */
export async function resolveCandidates({
  presetModels,
  now = Date.now(),
}: {
  presetModels: string[]
  now?: number
}): Promise<{
  candidates: Candidate[]
  coolingDown: CoolingCandidate[]
  skipped: string[]
  retryAfterMs?: number
}> {
  const accounts = await loadAccounts()
  const state = await loadState()
  const candidates: Candidate[] = []
  const coolingDown: CoolingCandidate[] = []
  const skipped: string[] = []
  let retryAfterMs: number | undefined

  for (const entry of presetModels) {
    const slash = entry.indexOf('/')
    if (slash <= 0) continue
    const providerRaw = entry.slice(0, slash)
    const modelId = entry.slice(slash + 1)
    if (!isProviderId(providerRaw)) {
      skipped.push(`${entry}: unknown provider`)
      continue
    }
    const provider = providerRaw
    const pool = accounts.providers[provider]
    if (!pool || pool.accounts.length === 0) {
      skipped.push(`${entry}: no accounts (run: subrouter login ${provider})`)
      continue
    }
    for (let offset = 0; offset < pool.accounts.length; offset++) {
      const accountIndex = (pool.activeIndex + offset) % pool.accounts.length
      const account = pool.accounts[accountIndex]
      if (!account) continue
      if (isCoolingDown({ state, provider, account, now })) {
        skipped.push(`${entry}: ${accountLabel(account, accountIndex)} cooling down`)
        const until = state.cooldowns[cooldownKey({ provider, account })]
        if (typeof until === 'number') {
          const remaining = until - now
          if (remaining > 0) {
            coolingDown.push({ provider, modelId, account, accountIndex, until })
            retryAfterMs = retryAfterMs === undefined ? remaining : Math.min(retryAfterMs, remaining)
          }
        }
        continue
      }
      candidates.push({ provider, modelId, account, accountIndex })
    }
  }

  return { candidates, coolingDown, skipped, retryAfterMs }
}

// OpenCode only retries APICallError with isRetryable. A tagged NoUsableAccountError
// becomes UnknownError and kills the session instead of waiting out the cooldown.
function cooldownRetryError({
  message,
  retryAfterMs,
  cause,
}: {
  message: string
  retryAfterMs: number
  cause?: Error
}) {
  const waitMs = Math.max(1, Math.ceil(retryAfterMs))
  return new APICallError({
    message,
    url: 'https://subrouter.local/cooldown',
    requestBodyValues: {},
    statusCode: 429,
    responseHeaders: {
      'retry-after-ms': String(waitMs),
      'retry-after': String(Math.max(1, Math.ceil(waitMs / 1000))),
    },
    responseBody: message,
    isRetryable: true,
    cause,
  })
}

export function formatCandidateRef(candidate: Pick<Candidate, 'provider' | 'modelId'>) {
  return `${candidate.provider}/${candidate.modelId}`
}

export type RouterEvent =
  | { type: 'trying'; candidate: Candidate }
  | { type: 'failover'; candidate: Candidate; error: Error; cooldownMs: number }

function formatCandidateLog(candidate: Candidate) {
  return `${formatCandidateRef(candidate)} ${accountLabel(candidate.account, candidate.accountIndex)}`
}

export function logRouterEvent(event: RouterEvent, log?: SubrouterLog) {
  const extra = {
    provider: event.candidate.provider,
    modelId: event.candidate.modelId,
    account: accountLabel(event.candidate.account),
    accountIndex: event.candidate.accountIndex,
  }
  if (event.type === 'trying') {
    emitLog(log, {
      level: 'info',
      message: `trying ${formatCandidateLog(event.candidate)}`,
      extra,
    })
    return
  }
  emitLog(log, {
    level: 'warn',
    message: `failover ${formatCandidateLog(event.candidate)}`,
    extra: {
      ...extra,
      error: event.error.message,
      cooldownMs: event.cooldownMs,
    },
  })
}

export async function resolveActiveCandidate(preset: string) {
  const presetModels = await resolvePresetModels(preset)
  if (presetModels instanceof Error) return null
  const { candidates } = await resolveCandidates({ presetModels })
  return candidates[0] ?? null
}

/** In-flight session route if one exists, else the first cooldown-aware candidate. */
export async function resolveLiveModel({
  preset,
  sessionID,
}: {
  preset: string
  sessionID?: string
}) {
  if (sessionID) {
    const live = await getLiveRoute(sessionID)
    if (live && live.preset === preset) {
      return { provider: live.provider, modelId: live.modelId }
    }
  }
  const candidate = await resolveActiveCandidate(preset)
  if (!candidate) return null
  return { provider: candidate.provider, modelId: candidate.modelId }
}

type Attempt<T> = { ok: true; value: T } | { ok: false; error: Error }

function messageFromUnknownError<T>(value: T) {
  if (value instanceof Error) return value.message
  if (typeof value === 'string' && value.length > 0) return value
  const message = Reflect.get(Object(value), 'message')
  if (typeof message === 'string' && message.length > 0) return message
  const nested = Object(Reflect.get(Object(value), 'error'))
  const nestedMessage = Reflect.get(nested, 'message')
  if (typeof nestedMessage === 'string' && nestedMessage.length > 0) return nestedMessage
  const code = Reflect.get(nested, 'code')
  if (typeof code === 'string' && code.length > 0) return code
  const type = Reflect.get(nested, 'type')
  if (typeof type === 'string' && type.length > 0) return type
  return 'Provider stream error'
}

function errorFromUnknown<T>(value: T) {
  if (value instanceof Error) return value
  return new Error(messageFromUnknownError(value), { cause: value })
}

export type RouterModelArgs = {
  /** preset name, exposed as the modelId */
  preset: string
  affinity?: RouteAffinity
  onEvent?: (event: RouterEvent) => void
  onCooldownFallback?: (notice: CooldownFallbackNotice) => void | Promise<void>
  log?: SubrouterLog
}

export class RouterModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3' as const
  readonly provider = PROVIDER_ID
  readonly modelId: string
  readonly supportedUrls: Record<string, RegExp[]> = {}
  private affinity?: RouteAffinity
  private onEvent?: (event: RouterEvent) => void
  private onCooldownFallback?: (notice: CooldownFallbackNotice) => void | Promise<void>
  private log?: SubrouterLog

  constructor(args: RouterModelArgs) {
    this.modelId = args.preset
    this.affinity = args.affinity
    this.onEvent = args.onEvent
    this.onCooldownFallback = args.onCooldownFallback
    this.log = args.log
  }

  private buildModel(candidate: Candidate) {
    const adapter = adapters[candidate.provider]
    return adapter.createModel({
      modelId: candidate.modelId,
      account: candidate.account,
      persist: async (update) => {
        await updateAccount({
          provider: candidate.provider,
          match: candidate.account,
          update,
        })
      },
    })
  }

  private reportCooldownFallback({
    presetModels,
    candidates,
    coolingDown,
    options,
  }: {
    presetModels: string[]
    candidates: Candidate[]
    coolingDown: CoolingCandidate[]
    options: LanguageModelV3CallOptions
  }) {
    if (!this.onCooldownFallback) return
    const preferredEntry = presetModels[0]
    if (!preferredEntry) return
    const slash = preferredEntry.indexOf('/')
    if (slash <= 0) return
    const provider = preferredEntry.slice(0, slash)
    if (!isProviderId(provider)) return
    const modelId = preferredEntry.slice(slash + 1)
    const isPreferred = (candidate: Pick<Candidate, 'provider' | 'modelId'>) =>
      candidate.provider === provider && candidate.modelId === modelId
    if (candidates.some(isPreferred)) return
    const preferredCooldowns = coolingDown.filter(isPreferred)
    const active = candidates[0]
    if (!active || preferredCooldowns.length === 0) return

    const headers = new Headers()
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      if (value !== undefined) headers.set(key, value)
    }
    const notice: CooldownFallbackNotice = {
      sessionID: headers.get(OPENAI_WEBSOCKET_SESSION_HEADER) ?? undefined,
      agent: headers.get(OPENCODE_AGENT_HEADER) ?? undefined,
      variant: headers.get(OPENCODE_VARIANT_HEADER) ?? undefined,
      preset: this.modelId,
      preferred: {
        provider,
        modelId,
        retryAfterMs: Math.max(1, Math.min(...preferredCooldowns.map((item) => item.until - Date.now()))),
      },
      active: { provider: active.provider, modelId: active.modelId },
    }
    void Promise.resolve()
      .then(() => this.onCooldownFallback!(notice))
      .catch((cause) => {
        const error = cause instanceof Error ? cause : new Error(String(cause))
        emitLog(this.log, {
          level: 'warn',
          message: 'failed to report cooldown fallback',
          extra: { error: error.message },
        })
      })
  }

  private async withFailover<T>({
    options,
    run,
    inspect = async (value) => ({ ok: true, value }),
  }: {
    options: LanguageModelV3CallOptions
    run: (model: LanguageModelV3, candidate: Candidate) => PromiseLike<T>
    inspect?: (value: T, candidate: Candidate) => Promise<Attempt<T>>
  }): Promise<T> {
    const presetModels = await resolvePresetModels(this.modelId)
    if (presetModels instanceof Error) throw presetModels

    const required = requiredInputModalities(options)
    const compatible =
      required.size === 1
        ? { presetModels, skipped: [] }
        : filterPresetModelsByInput({
            presetModels,
            required,
            catalog: await loadModelsDevCatalog({ log: this.log }),
          })
    const resolved = await resolveCandidates({ presetModels: compatible.presetModels })
    const headers = new Headers()
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      if (value !== undefined) headers.set(key, value)
    }
    const affinityKey = headers.get(ROUTE_AFFINITY_HEADER)
    const candidates = this.affinity?.prioritize(affinityKey, resolved.candidates) ?? resolved.candidates
    const skipped = [...compatible.skipped, ...resolved.skipped]
    for (const reason of skipped) {
      emitLog(this.log, { level: 'info', message: `skip ${reason}` })
    }
    if (candidates.length === 0) {
      const reason = skipped.length > 0 ? skipped.join('; ') : 'no providers configured'
      const error = new NoUsableAccountError({ preset: this.modelId, reason })
      if (resolved.retryAfterMs !== undefined) {
        throw cooldownRetryError({
          message: error.message,
          retryAfterMs: resolved.retryAfterMs,
          cause: error,
        })
      }
      throw error
    }

    this.reportCooldownFallback({
      presetModels: compatible.presetModels,
      candidates,
      coolingDown: resolved.coolingDown,
      options,
    })

    const attempts: string[] = []
    let soonestRetryAfterMs: number | undefined
    for (const candidate of candidates) {
      const trying = { type: 'trying' as const, candidate }
      this.onEvent?.(trying)
      logRouterEvent(trying, this.log)
      const model = this.buildModel(candidate)
      const result = await Promise.resolve()
        .then(() => run(model, candidate))
        .then(
          (value) => ({ ok: true as const, value }),
          (error) => ({
            ok: false as const,
            error: errorFromUnknown(error),
          }),
        )
      const inspected: Attempt<T> = result.ok
        ? await Promise.resolve()
            .then(() => inspect(result.value, candidate))
            .then(
              (value) => value,
              (error) => ({
                ok: false as const,
                error: errorFromUnknown(error),
              }),
            )
        : result
      if (inspected.ok) {
        this.affinity?.select(affinityKey, candidate)
        const sessionID = headers.get(OPENAI_WEBSOCKET_SESSION_HEADER)
        if (sessionID && !headers.get(OPENAI_WEBSOCKET_TITLE_HEADER)) {
          await setLiveRoute({
            sessionID,
            preset: this.modelId,
            provider: candidate.provider,
            modelId: candidate.modelId,
          })
        }
        return inspected.value
      }

      const error = inspected.error
      const action = classifyFailure(failureDetailsFromError(error))
      if (!action) throw error

      await markCooldown({
        provider: candidate.provider,
        account: candidate.account,
        untilMs: Date.now() + action.cooldownMs,
      })
      soonestRetryAfterMs =
        soonestRetryAfterMs === undefined
          ? action.cooldownMs
          : Math.min(soonestRetryAfterMs, action.cooldownMs)
      const failover = { type: 'failover' as const, candidate, error, cooldownMs: action.cooldownMs }
      this.onEvent?.(failover)
      logRouterEvent(failover, this.log)
      attempts.push(
        `${candidate.provider}/${candidate.modelId} ${accountLabel(candidate.account, candidate.accountIndex)}: ${error.message}`,
      )
    }

    const exhausted = new AllCandidatesExhaustedError({
      preset: this.modelId,
      attempts: attempts.join('; '),
    })
    if (soonestRetryAfterMs !== undefined) {
      throw cooldownRetryError({
        message: exhausted.message,
        retryAfterMs: soonestRetryAfterMs,
        cause: exhausted,
      })
    }
    throw exhausted
  }

  async doGenerate(options: LanguageModelV3CallOptions) {
    return this.withFailover({
      options,
      run: (model, candidate) => model.doGenerate(candidateCallOptions({ options, candidate })),
    })
  }

  async doStream(options: LanguageModelV3CallOptions) {
    return this.withFailover({
      options,
      run: (model, candidate) => model.doStream(candidateCallOptions({ options, candidate })),
      inspect: (result, candidate) =>
        inspectStream({
          result,
          onCommittedError: (error, replaySafe) => recordStreamCooldown({ candidate, error, replaySafe }),
        }),
    })
  }
}

async function inspectStream({
  result,
  onCommittedError,
}: {
  result: LanguageModelV3StreamResult
  onCommittedError: (error: Error, replaySafe: boolean) => Promise<Error>
}): Promise<Attempt<LanguageModelV3StreamResult>> {
  const reader = result.stream.getReader()
  const buffered: LanguageModelV3StreamPart[] = []
  while (true) {
    const next = await reader.read().catch(errorFromUnknown)
    if (next instanceof Error) {
      await reader.cancel(next).catch(() => {})
      return { ok: false, error: next }
    }
    if (next.done) {
      return {
        ok: true,
        value: { ...result, stream: continueStream({ reader, buffered, onCommittedError }) },
      }
    }
    if (next.value.type === 'error') {
      const error = errorFromUnknown(next.value.error)
      await reader.cancel(error).catch(() => {})
      return { ok: false, error }
    }
    buffered.push(next.value)
    // stream-start is local (TransformStream.start). Do not read the next
    // part. That wait is the first SSE event, often after Grok thinking.
    return {
      ok: true,
      value: { ...result, stream: continueStream({ reader, buffered, onCommittedError }) },
    }
  }
}

function isReplaySafePart(part: LanguageModelV3StreamPart) {
  return part.type === 'stream-start' || part.type === 'response-metadata'
}

function continueStream({
  reader,
  buffered,
  onCommittedError,
}: {
  reader: ReadableStreamDefaultReader<LanguageModelV3StreamPart>
  buffered: LanguageModelV3StreamPart[]
  onCommittedError: (error: Error, replaySafe: boolean) => Promise<Error>
}) {
  let recordedError: Error | undefined
  let replaySafe = true
  const record = async (error: Error) => {
    if (recordedError) return recordedError
    recordedError = await onCommittedError(error, replaySafe)
    return recordedError
  }
  let bufferedIndex = 0
  return new ReadableStream<LanguageModelV3StreamPart>({
    async pull(controller) {
      if (bufferedIndex < buffered.length) {
        const part = buffered[bufferedIndex++]!
        if (!isReplaySafePart(part)) replaySafe = false
        controller.enqueue(part)
        return
      }
      const next = await reader.read().catch(errorFromUnknown)
      if (next instanceof Error) {
        controller.error(await record(next))
        return
      }
      if (next.done) {
        controller.close()
        return
      }
      if (next.value.type === 'error') {
        const error = errorFromUnknown(next.value.error)
        controller.enqueue({ ...next.value, error: await record(error) })
        return
      }
      if (!isReplaySafePart(next.value)) replaySafe = false
      controller.enqueue(next.value)
    },
    cancel: reader.cancel.bind(reader),
  })
}

async function recordStreamCooldown({
  candidate,
  error,
  replaySafe,
}: {
  candidate: Candidate
  error: Error
  replaySafe: boolean
}) {
  const details = failureDetailsFromError(error)
  const action = classifyFailure(details)
  if (!action) return error
  await markCooldown({
    provider: candidate.provider,
    account: candidate.account,
    untilMs: Date.now() + action.cooldownMs,
  })
  if (!replaySafe) return error
  return new APICallError({
    message: error.message,
    url: APICallError.isInstance(error) ? error.url : 'https://subrouter.local/retry',
    requestBodyValues: APICallError.isInstance(error) ? error.requestBodyValues : {},
    statusCode: details.statusCode,
    responseHeaders: details.headers,
    responseBody: details.body,
    isRetryable: true,
    cause: error,
  })
}

const ENCRYPTED_REASONING = 'reasoning.encrypted_content'

function withEncryptedReasoningInclude(include: JSONValue | undefined) {
  const values = Array.isArray(include)
    ? include.filter((item): item is string => typeof item === 'string')
    : []
  if (!values.includes(ENCRYPTED_REASONING)) values.push(ENCRYPTED_REASONING)
  return values
}

function sdkProviderOptionsKey(provider: ProviderId) {
  if (provider === 'openai' || provider === 'github-copilot') return 'openai'
  if (provider === 'xai') return 'xai'
  if (provider === 'anthropic') return 'anthropic'
  return null
}

function candidateProviderOptions({
  options,
  candidate,
}: {
  options: LanguageModelV3CallOptions
  candidate: Candidate
}) {
  const current = { ...options.providerOptions }
  const sdkKey = sdkProviderOptionsKey(candidate.provider)
  const harness = current[PROVIDER_ID]
  if (sdkKey && isJSONObject(harness)) {
    current[sdkKey] = { ...current[sdkKey], ...harness }
  }
  const openai = isJSONObject(current.openai) ? current.openai : {}
  const xai = isJSONObject(current.xai) ? current.xai : {}
  return {
    ...current,
    openai: { ...openai, store: false, include: withEncryptedReasoningInclude(openai.include) },
    xai: { ...xai, store: false },
  }
}

function candidateCallOptions({
  options,
  candidate,
}: {
  options: LanguageModelV3CallOptions
  candidate: Candidate
}) {
  const headers = new Headers()
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (value !== undefined) headers.set(key, value)
  }
  const sessionId = headers.get(OPENAI_WEBSOCKET_SESSION_HEADER)
  const title = headers.get(OPENAI_WEBSOCKET_TITLE_HEADER)
  headers.delete(OPENAI_WEBSOCKET_SESSION_HEADER)
  headers.delete(OPENAI_WEBSOCKET_TITLE_HEADER)
  headers.delete(OPENCODE_AGENT_HEADER)
  headers.delete(OPENCODE_VARIANT_HEADER)
  headers.delete(ROUTE_AFFINITY_HEADER)
  if (candidate.provider === 'openai' && sessionId) {
    headers.set(OPENAI_WEBSOCKET_SESSION_HEADER, sessionId)
  }
  if (candidate.provider === 'openai' && title) headers.set(OPENAI_WEBSOCKET_TITLE_HEADER, title)
  if (candidate.provider === 'opencode-go') {
    headers.set(OPENCODE_GO_SESSION_HEADER, sessionId || randomUUID())
  }
  return {
    ...options,
    headers: Object.fromEntries(headers),
    providerOptions: candidateProviderOptions({ options, candidate }),
  }
}

/**
 * AI SDK provider factory. OpenCode imports the provider module and calls the
 * first export starting with `create`, then `sdk.languageModel(modelId)`.
 * GPT presets spoof a `gpt-*` api id so OpenCode prefers apply_patch;
 * `presetByApiId` maps that id back to the preset name.
 */
export function createSubrouter(
  options: {
    affinity?: RouteAffinity
    onEvent?: (event: RouterEvent) => void
    onCooldownFallback?: (notice: CooldownFallbackNotice) => void | Promise<void>
    log?: SubrouterLog
    presetByApiId?: Record<string, string>
  } = {},
) {
  const model = (apiId: string) =>
    new RouterModel({
      preset: options.presetByApiId?.[apiId] ?? apiId,
      affinity: options.affinity,
      onEvent: options.onEvent,
      onCooldownFallback: options.onCooldownFallback,
      log: options.log,
    })
  return {
    languageModel: model,
    chat: model,
  }
}
