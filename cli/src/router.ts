/**
 * The subrouter routing engine.
 *
 * A RouterModel is an AI SDK LanguageModelV3 whose modelId is a preset name.
 * On every call it resolves the preset to an ordered list of candidates
 * (provider/model plus one entry per logged-in account), skips accounts in
 * cooldown, and delegates to the first usable underlying model. When a call
 * fails with a rate-limit/usage error, the account is put in cooldown
 * (globally, in ~/.subrouter/state.json) and the next candidate is tried.
 * It only throws when every candidate is exhausted.
 */

import type { LanguageModelV3, LanguageModelV3CallOptions } from '@ai-sdk/provider'
import * as errore from 'errore'
import { adapters, classifyFailure, failureDetailsFromError } from './adapters/index.ts'
import {
  isCoolingDown,
  loadAccounts,
  loadPresets,
  loadState,
  markCooldown,
  updateAccount,
  accountLabel,
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

export const DEFAULT_PROVIDER_ORDER: ProviderId[] = ['anthropic', 'openai', 'xai', 'opencode']
export const DEFAULT_PRESET_NAME = 'default'

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
}): Promise<{ candidates: Candidate[]; skipped: string[] }> {
  const accounts = await loadAccounts()
  const state = await loadState()
  const candidates: Candidate[] = []
  const skipped: string[] = []

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
        continue
      }
      candidates.push({ provider, modelId, account, accountIndex })
    }
  }

  return { candidates, skipped }
}

export type RouterEvent =
  | { type: 'trying'; candidate: Candidate }
  | { type: 'failover'; candidate: Candidate; error: Error; cooldownMs: number }

export type RouterModelArgs = {
  /** preset name, exposed as the modelId */
  preset: string
  onEvent?: (event: RouterEvent) => void
}

export class RouterModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3' as const
  readonly provider = 'subrouter'
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

  private async withFailover<T>(run: (model: LanguageModelV3) => PromiseLike<T>): Promise<T> {
    const presetModels = await resolvePresetModels(this.modelId)
    if (presetModels instanceof Error) throw presetModels

    const { candidates, skipped } = await resolveCandidates({ presetModels })
    if (candidates.length === 0) {
      throw new NoUsableAccountError({
        preset: this.modelId,
        reason: skipped.length > 0 ? skipped.join('; ') : 'no providers configured',
      })
    }

    const attempts: string[] = []
    for (const candidate of candidates) {
      this.onEvent?.({ type: 'trying', candidate })
      const model = this.buildModel(candidate)
      const result = await Promise.resolve()
        .then(() => run(model))
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error : new Error(String(error)),
          }),
        )
      if (result.ok) return result.value

      const error = result.error
      const action = classifyFailure(failureDetailsFromError(error))
      if (!action) throw error

      await markCooldown({
        provider: candidate.provider,
        account: candidate.account,
        untilMs: Date.now() + action.cooldownMs,
      })
      this.onEvent?.({ type: 'failover', candidate, error, cooldownMs: action.cooldownMs })
      attempts.push(
        `${candidate.provider}/${candidate.modelId} ${accountLabel(candidate.account, candidate.accountIndex)}: ${error.message}`,
      )
    }

    throw new AllCandidatesExhaustedError({
      preset: this.modelId,
      attempts: attempts.join('; '),
    })
  }

  async doGenerate(options: LanguageModelV3CallOptions) {
    return this.withFailover((model) => model.doGenerate(options))
  }

  async doStream(options: LanguageModelV3CallOptions) {
    return this.withFailover((model) => model.doStream(options))
  }
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
