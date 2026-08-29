/**
 * The subrouter routing engine.
 *
 * A RouterModel is an AI SDK LanguageModelV3 whose modelId is a preset name.
 * On every call it resolves the preset to an ordered list of candidates
 * (provider/model plus one entry per logged-in account), skips accounts in
 * cooldown, and delegates to the first usable underlying model. When a call
 * fails with a rate-limit/usage error, the account is put in cooldown
 * (globally, in ~/.subrouter/state.json) and the next candidate is tried.
 * Cooling-down-only failures throw a retryable 429 so OpenCode waits
 * instead of dying. It only throws a hard error when nothing can be retried.
 */

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider'
import { APICallError } from '@ai-sdk/provider'
import * as errore from 'errore'
import { adapters, classifyFailure, failureDetailsFromError } from './adapters/index.ts'
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
}): Promise<{ candidates: Candidate[]; skipped: string[]; retryAfterMs?: number }> {
  const accounts = await loadAccounts()
  const state = await loadState()
  const candidates: Candidate[] = []
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
            retryAfterMs = retryAfterMs === undefined ? remaining : Math.min(retryAfterMs, remaining)
          }
        }
        continue
      }
      candidates.push({ provider, modelId, account, accountIndex })
    }
  }

  return { candidates, skipped, retryAfterMs }
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

export async function resolveActiveCandidate(preset: string) {
  const presetModels = await resolvePresetModels(preset)
  if (presetModels instanceof Error) return null
  const { candidates } = await resolveCandidates({ presetModels })
  return candidates[0] ?? null
}

export type RouterEvent =
  | { type: 'trying'; candidate: Candidate }
  | { type: 'failover'; candidate: Candidate; error: Error; cooldownMs: number }

type Attempt<T> = { ok: true; value: T } | { ok: false; error: Error }

export type RouterModelArgs = {
  /** preset name, exposed as the modelId */
  preset: string
  onEvent?: (event: RouterEvent) => void
}

export class RouterModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3' as const
  readonly provider = PROVIDER_ID
  readonly modelId: string
  readonly supportedUrls: Record<string, RegExp[]> = {}
  private onEvent?: (event: RouterEvent) => void

  constructor(args: RouterModelArgs) {
    this.modelId = args.preset
    this.onEvent = args.onEvent
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

  private async withFailover<T>(
    run: (model: LanguageModelV3, candidate: Candidate) => PromiseLike<T>,
    inspect: (value: T, candidate: Candidate) => Promise<Attempt<T>> = async (value) => ({
      ok: true,
      value,
    }),
  ): Promise<T> {
    const presetModels = await resolvePresetModels(this.modelId)
    if (presetModels instanceof Error) throw presetModels

    const { candidates, skipped, retryAfterMs } = await resolveCandidates({ presetModels })
    if (candidates.length === 0) {
      const reason = skipped.length > 0 ? skipped.join('; ') : 'no providers configured'
      const error = new NoUsableAccountError({ preset: this.modelId, reason })
      if (retryAfterMs !== undefined) {
        throw cooldownRetryError({ message: error.message, retryAfterMs, cause: error })
      }
      throw error
    }

    const attempts: string[] = []
    let soonestRetryAfterMs: number | undefined
    for (const candidate of candidates) {
      this.onEvent?.({ type: 'trying', candidate })
      const model = this.buildModel(candidate)
      const result = await Promise.resolve()
        .then(() => run(model, candidate))
        .then(
          (value) => ({ ok: true as const, value }),
          (error) => ({
            ok: false as const,
            error: error instanceof Error ? error : new Error(String(error)),
          }),
        )
      const inspected: Attempt<T> = result.ok
        ? await Promise.resolve()
            .then(() => inspect(result.value, candidate))
            .then(
              (value) => value,
              (error) => ({
                ok: false as const,
                error: error instanceof Error ? error : new Error(String(error)),
              }),
            )
        : result
      if (inspected.ok) return inspected.value

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
      this.onEvent?.({ type: 'failover', candidate, error, cooldownMs: action.cooldownMs })
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
    return this.withFailover((model, candidate) =>
      model.doGenerate(candidateCallOptions({ options, candidate })),
    )
  }

  async doStream(options: LanguageModelV3CallOptions) {
    return this.withFailover(
      (model, candidate) => model.doStream(candidateCallOptions({ options, candidate })),
      (result, candidate) =>
        inspectStream({
          result,
          onCommittedError: (error) => recordStreamCooldown({ candidate, error }),
        }),
    )
  }
}

async function inspectStream({
  result,
  onCommittedError,
}: {
  result: LanguageModelV3StreamResult
  onCommittedError: (error: Error) => Promise<void>
}): Promise<Attempt<LanguageModelV3StreamResult>> {
  const reader = result.stream.getReader()
  const buffered: LanguageModelV3StreamPart[] = []
  while (true) {
    const next = await reader
      .read()
      .catch((error) => (error instanceof Error ? error : new Error(String(error))))
    if (next instanceof Error) return { ok: false, error: next }
    if (next.done) {
      return {
        ok: true,
        value: { ...result, stream: continueStream({ reader, buffered, onCommittedError }) },
      }
    }
    if (next.value.type === 'error') {
      return {
        ok: false,
        error:
          next.value.error instanceof Error
            ? next.value.error
            : new Error(String(next.value.error)),
      }
    }
    buffered.push(next.value)
    if (next.value.type === 'stream-start' || next.value.type === 'response-metadata') continue
    return {
      ok: true,
      value: { ...result, stream: continueStream({ reader, buffered, onCommittedError }) },
    }
  }
}

function continueStream({
  reader,
  buffered,
  onCommittedError,
}: {
  reader: ReadableStreamDefaultReader<LanguageModelV3StreamPart>
  buffered: LanguageModelV3StreamPart[]
  onCommittedError: (error: Error) => Promise<void>
}) {
  let recordedCooldown = false
  const record = async (error: Error) => {
    if (recordedCooldown) return
    await onCommittedError(error)
    recordedCooldown = true
  }
  let bufferedIndex = 0
  return new ReadableStream<LanguageModelV3StreamPart>({
    async pull(controller) {
      if (bufferedIndex < buffered.length) {
        controller.enqueue(buffered[bufferedIndex++]!)
        return
      }
      const next = await reader
        .read()
        .catch((error) => (error instanceof Error ? error : new Error(String(error))))
      if (next instanceof Error) {
        await record(next)
        controller.error(next)
        return
      }
      if (next.done) {
        controller.close()
        return
      }
      if (next.value.type === 'error') {
        await record(
          next.value.error instanceof Error
            ? next.value.error
            : new Error(String(next.value.error)),
        )
      }
      controller.enqueue(next.value)
    },
    cancel: reader.cancel.bind(reader),
  })
}

async function recordStreamCooldown({ candidate, error }: { candidate: Candidate; error: Error }) {
  const action = classifyFailure(failureDetailsFromError(error))
  if (!action) return
  await markCooldown({
    provider: candidate.provider,
    account: candidate.account,
    untilMs: Date.now() + action.cooldownMs,
  })
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
  if (candidate.provider === 'openai' && sessionId) {
    headers.set(OPENAI_WEBSOCKET_SESSION_HEADER, sessionId)
  }
  if (candidate.provider === 'openai' && title) headers.set(OPENAI_WEBSOCKET_TITLE_HEADER, title)
  return { ...options, headers: Object.fromEntries(headers) }
}

/**
 * AI SDK provider factory. OpenCode imports the provider module and calls the
 * first export starting with `create`, then `sdk.languageModel(modelId)`.
 */
export function createSubrouter(options: { onEvent?: (event: RouterEvent) => void } = {}) {
  return {
    languageModel(presetName: string) {
      return new RouterModel({ preset: presetName, onEvent: options.onEvent })
    },
    chat(presetName: string) {
      return new RouterModel({ preset: presetName, onEvent: options.onEvent })
    },
  }
}
