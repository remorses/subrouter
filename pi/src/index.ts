/** Pi extension that routes subrouter presets through Pi's native providers. */

import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type Provider,
  type ProviderResponse,
  type StreamOptions,
} from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  accountLabel,
  adapters,
  AllCandidatesExhaustedError,
  classifyFailure,
  DEFAULT_PRESET_NAME,
  isProviderId,
  loadAccounts,
  loadPresets,
  markCooldown,
  NoUsableAccountError,
  resolveCandidates,
  resolvePresetModels,
  updateAccount,
  type Candidate,
  type ProviderId,
} from '@subrouter/cli'

const PI_PROVIDER_IDS: Record<ProviderId, string> = {
  anthropic: 'anthropic',
  openai: 'openai-codex',
  xai: 'xai',
  opencode: 'opencode',
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

function errorMessage({ model, error, aborted = false }: { model: Model<Api>; error: Error; aborted?: boolean }) {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { ...ZERO_COST, total: 0 },
    },
    stopReason: aborted ? ('aborted' as const) : ('error' as const),
    errorMessage: error.message,
    timestamp: Date.now(),
  } satisfies AssistantMessage
}

function endWithError({
  stream,
  model,
  error,
  aborted = false,
}: {
  stream: AssistantMessageEventStream
  model: Model<Api>
  error: Error
  aborted?: boolean
}) {
  const message = errorMessage({ model, error, aborted })
  stream.push({ type: 'start', partial: message })
  stream.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: message })
  stream.end()
}

function parsePresetEntry(entry: string) {
  const slash = entry.indexOf('/')
  if (slash <= 0) return null
  const provider = entry.slice(0, slash)
  if (!isProviderId(provider)) return null
  return { provider, modelId: entry.slice(slash + 1) }
}

function targetModel({ candidate, providers }: { candidate: Candidate; providers: Map<string, Provider> }) {
  const provider = providers.get(PI_PROVIDER_IDS[candidate.provider])
  const model = provider?.getModels().find((entry) => entry.id === candidate.modelId)
  if (!provider || !model) return null
  const baseUrl = process.env[adapters[candidate.provider].baseUrlEnvVar]?.replace(/\/+$/, '')
  return { provider, model: baseUrl ? { ...model, baseUrl } : model }
}

function presetModel({
  preset,
  entries,
  providers,
}: {
  preset: string
  entries: string[]
  providers: Map<string, Provider>
}): Model<Api> {
  const targets = entries
    .map(parsePresetEntry)
    .filter((entry) => entry !== null)
    .map((entry) => providers.get(PI_PROVIDER_IDS[entry.provider])?.getModels().find((model) => model.id === entry.modelId))
    .filter((model) => model !== undefined)
  const contextWindow = targets.length > 0 ? Math.min(...targets.map((model) => model.contextWindow)) : 128_000
  const maxTokens = targets.length > 0 ? Math.min(...targets.map((model) => model.maxTokens)) : 16_384
  const supportsImages = targets.length > 0 && targets.every((model) => model.input.includes('image'))
  return {
    id: preset,
    name: `subrouter ${preset}`,
    api: 'subrouter',
    provider: 'subrouter',
    baseUrl: 'subrouter://local',
    reasoning: targets.length > 0 && targets.every((model) => model.reasoning),
    input: supportsImages ? ['text', 'image'] : ['text'],
    cost: ZERO_COST,
    contextWindow,
    maxTokens,
  }
}

async function recordCooldown({ candidate, cooldownMs }: { candidate: Candidate; cooldownMs: number }) {
  await markCooldown({
    provider: candidate.provider,
    account: candidate.account,
    untilMs: Date.now() + cooldownMs,
  })
}

function streamPreset({
  model,
  context,
  options,
  providers,
}: {
  model: Model<Api>
  context: Context
  options?: StreamOptions
  providers: Map<string, Provider>
}) {
  const stream = createAssistantMessageEventStream()

  void (async () => {
    const presetModels = await resolvePresetModels(model.id)
    if (presetModels instanceof Error) {
      endWithError({ stream, model, error: presetModels })
      return
    }

    const { candidates, skipped } = await resolveCandidates({ presetModels })
    if (candidates.length === 0) {
      endWithError({
        stream,
        model,
        error: new NoUsableAccountError({
          preset: model.id,
          reason: skipped.length > 0 ? skipped.join('; ') : 'no providers configured',
        }),
      })
      return
    }

    const attempts: string[] = []
    candidateLoop: for (const candidate of candidates) {
      if (options?.signal?.aborted) {
        endWithError({ stream, model, error: new Error('Request was aborted'), aborted: true })
        return
      }

      const target = targetModel({ candidate, providers })
      if (!target) {
        endWithError({
          stream,
          model,
          error: new Error(`Pi does not provide model ${candidate.provider}/${candidate.modelId}`),
        })
        return
      }

      const persist = async (update: Partial<Candidate['account']>) => {
        await updateAccount({ provider: candidate.provider, match: candidate.account, update })
      }
      const apiKey = await adapters[candidate.provider].getApiKey({ account: candidate.account, persist })
      if (apiKey instanceof Error) {
        const action = classifyFailure({ message: apiKey.message })
        if (!action) {
          endWithError({ stream, model: target.model, error: apiKey })
          return
        }
        await recordCooldown({ candidate, cooldownMs: action.cooldownMs })
        attempts.push(`${candidate.provider}/${candidate.modelId}: ${apiKey.message}`)
        continue
      }

      let response: ProviderResponse | undefined
      const inner = target.provider.streamSimple(target.model, context, {
        ...options,
        apiKey,
        maxRetries: 0,
        transport: candidate.provider === 'openai' ? 'sse' : options?.transport,
        onResponse: async (received, responseModel) => {
          response = received
          await options?.onResponse?.(received, responseModel)
        },
      })
      let start: AssistantMessageEvent | undefined
      let committed = false
      for await (const event of inner) {
        if (event.type === 'start') {
          start = event
          continue
        }
        if (event.type === 'error') {
          const action = classifyFailure({
            statusCode: response?.status,
            headers: response?.headers,
            message: event.error.errorMessage ?? 'Provider request failed',
          })
          if (action) await recordCooldown({ candidate, cooldownMs: action.cooldownMs })
          if (action && !committed) {
            attempts.push(
              `${candidate.provider}/${candidate.modelId} ${accountLabel(candidate.account, candidate.accountIndex)}: ${event.error.errorMessage ?? 'Provider request failed'}`,
            )
            continue candidateLoop
          }
          if (!committed && start) stream.push(start)
          stream.push(event)
          stream.end()
          return
        }
        if (!committed) {
          committed = true
          if (start) stream.push(start)
        }
        stream.push(event)
        if (event.type === 'done') {
          stream.end()
          return
        }
      }

      endWithError({ stream, model: target.model, error: new Error('Provider stream ended without a result') })
      return
    }

    endWithError({
      stream,
      model,
      error: new AllCandidatesExhaustedError({ preset: model.id, attempts: attempts.join('; ') }),
    })
  })().catch((error) => {
    endWithError({ stream, model, error: error instanceof Error ? error : new Error(String(error)) })
  })

  return stream
}

async function createSubrouterProvider() {
  const providers = new Map(builtinProviders().map((provider) => [provider.id, provider]))
  const presets = await loadPresets()
  const names = new Set([DEFAULT_PRESET_NAME, ...Object.keys(presets.presets)])
  const models = await Promise.all(
    [...names].map(async (preset) => {
      const entries = await resolvePresetModels(preset)
      return presetModel({ preset, entries: entries instanceof Error ? [] : entries, providers })
    }),
  )
  return {
    id: 'subrouter',
    name: 'Subrouter',
    auth: {
      apiKey: {
        name: 'Subrouter accounts',
        async check() {
          const accounts = await loadAccounts()
          const configured = Object.values(accounts.providers).some((pool) => pool.accounts.length > 0)
          return configured ? { type: 'api_key' as const, source: '~/.subrouter' } : undefined
        },
        async resolve() {
          const accounts = await loadAccounts()
          const configured = Object.values(accounts.providers).some((pool) => pool.accounts.length > 0)
          return configured ? { auth: {}, source: '~/.subrouter' } : undefined
        },
      },
    },
    getModels: () => models,
    stream: (model, context, options) => streamPreset({ model, context, options, providers }),
    streamSimple: (model, context, options) => streamPreset({ model, context, options, providers }),
  } satisfies Provider
}

export default async function subrouterPiExtension(pi: ExtensionAPI) {
  pi.registerProvider(await createSubrouterProvider())
}
