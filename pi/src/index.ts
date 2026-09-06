/** Pi extension that routes subrouter presets through Pi's native providers.
 * Tool follow-ups stay on one route until the agent settles. Anthropic OAuth
 * strips Pi's identity. session_shutdown closes Codex sockets for `pi -p`. */

import {
  createAssistantMessageEventStream,
  createProvider,
  envApiKeyAuth,
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
import { closeOpenAICodexWebSocketSessions } from '@earendil-works/pi-ai/api/openai-codex-responses'
import crypto from 'node:crypto'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  accountLabel,
  adapters,
  AllCandidatesExhaustedError,
  OPENCODE_GO_SESSION_HEADER,
  classifyFailure,
  DEFAULT_PRESET_NAME,
  emitLog,
  formatCandidateRef,
  logRouterEvent,
  isProviderId,
  loadAccounts,
  loadPresets,
  markCooldown,
  NoUsableAccountError,
  PROVIDER_DISPLAY_NAME,
  PROVIDER_ID,
  resolveActiveCandidate,
  resolveCandidates,
  resolvePresetModels,
  RouteAffinity,
  clearLiveRoute,
  setLiveRoute,
  updateAccount,
  type Candidate,
  type ProviderId,
  type SubrouterLog,
} from '@subrouter/cli'

const PI_PROVIDER_IDS: Record<ProviderId, string> = {
  anthropic: 'anthropic',
  openai: 'openai-codex',
  xai: 'xai',
  'opencode-go': 'opencode-go',
  'github-copilot': 'github-copilot',
  poe: 'poe',
  minimax: 'minimax',
  kimi: 'kimi-coding',
  zai: 'zai',
  alibaba: 'alibaba',
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

function createOpenAICompatibleProvider({
  id,
  name,
  baseUrl,
  envVar,
  modelIds,
}: {
  id: string
  name: string
  baseUrl: string
  envVar: string
  modelIds: string[]
}) {
  const models: Model<'openai-completions'>[] = modelIds.map((modelId) => ({
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: id,
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: ZERO_COST,
    contextWindow: 128_000,
    maxTokens: 16_384,
  }))
  return createProvider({
    id,
    name,
    baseUrl,
    auth: { apiKey: envApiKeyAuth(`${name} API key`, [envVar]) },
    models,
    api: openAICompletionsApi(),
  })
}

function openAIModels(provider: Provider | undefined) {
  return (provider?.getModels() ?? []).filter(
    (model): model is Model<'openai-completions'> => model.api === 'openai-completions',
  )
}

function createAlibabaProvider({
  source,
  baseUrl,
  modelIds,
}: {
  source: Provider | undefined
  baseUrl: string
  modelIds: string[]
}) {
  const templates = openAIModels(source)
  const fallback = templates.find((model) => model.id === 'qwen3.7-plus')
  const models = modelIds.flatMap((modelId) => {
    const template = templates.find((model) => model.id === modelId) ?? fallback
    if (!template) return []
    return [{ ...template, id: modelId, name: modelId, provider: 'alibaba', baseUrl }]
  })
  return createProvider({
    id: 'alibaba',
    name: 'Alibaba Coding Plan',
    baseUrl,
    auth: { apiKey: envApiKeyAuth('Alibaba Coding Plan API key', ['ALIBABA_CODING_PLAN_API_KEY']) },
    models,
    api: openAICompletionsApi(),
  })
}

function createZaiProvider(source: Provider | undefined) {
  const models = openAIModels(source)
  const glm53 = models.find((model) => model.id === 'glm-5.3')
  if (glm53 && !models.some((model) => model.id === 'glm-5.3-highspeed')) {
    models.push({
      ...glm53,
      id: 'glm-5.3-highspeed',
      name: 'GLM-5.3 Highspeed',
      cost: ZERO_COST,
    })
  }
  return createProvider({
    id: 'zai',
    name: 'Z.AI',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    auth: { apiKey: envApiKeyAuth('Z.AI API key', ['ZAI_API_KEY']) },
    models,
    api: openAICompletionsApi(),
  })
}

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
    name: preset,
    api: 'subrouter',
    provider: PROVIDER_ID,
    baseUrl: 'subrouter://local',
    reasoning: targets.length > 0 && targets.every((model) => model.reasoning),
    input: supportsImages ? ['text', 'image'] : ['text'],
    cost: ZERO_COST,
    contextWindow,
    maxTokens,
  }
}

const PI_HARNESS_IDENTITY = ' operating inside pi, a coding agent harness'
const PI_DOCS_MARKER = '\nPi documentation (read only when the user asks about pi itself'
const PI_AFTER_DOCS = /\n\n|\nCurrent working directory:/

// Anthropic OAuth 400s Pi's default prompt: "operating inside pi" plus the
// Pi documentation block counts as a third-party app. Keep tools, cwd, skills,
// and --append-system-prompt. Docs have no blank line inside; later blocks
// start after one, except the cwd footer. Same idea as Archon's Pi provider.
function sanitizePiAnthropicSystemPrompt({ text, log }: { text: string; log?: SubrouterLog }) {
  const withoutIdentity = text.replace(PI_HARNESS_IDENTITY, '')
  const docsStart = withoutIdentity.indexOf(PI_DOCS_MARKER)
  if (docsStart === -1) {
    if (withoutIdentity.includes('operating inside pi') || withoutIdentity.includes('Pi documentation')) {
      emitLog(log, {
        level: 'warn',
        message: 'pi system prompt markers missing; anthropic oauth may reject',
      })
    }
    return withoutIdentity
  }
  const head = withoutIdentity.slice(0, docsStart).trimEnd()
  const afterDocs = withoutIdentity.slice(docsStart + 1)
  const nextSection = afterDocs.search(PI_AFTER_DOCS)
  return nextSection === -1 ? head : head + afterDocs.slice(nextSection)
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
  affinity,
  activeRouteKeys,
  log,
}: {
  model: Model<Api>
  context: Context
  options?: StreamOptions
  providers: Map<string, Provider>
  affinity: RouteAffinity
  activeRouteKeys: Map<string, string>
  log?: SubrouterLog
}) {
  const stream = createAssistantMessageEventStream()
  const routeKey = options?.sessionId ? activeRouteKeys.get(options.sessionId) ?? null : null

  void (async () => {
    const presetModels = await resolvePresetModels(model.id)
    if (presetModels instanceof Error) {
      endWithError({ stream, model, error: presetModels })
      return
    }

    const resolved = await resolveCandidates({ presetModels })
    const candidates = affinity.prioritize(routeKey, resolved.candidates)
    const skipped = resolved.skipped
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
    for (const reason of skipped) {
      emitLog(log, { level: 'info', message: `skip ${reason}` })
    }
    candidateLoop: for (const candidate of candidates) {
      if (options?.signal?.aborted) {
        endWithError({ stream, model, error: new Error('Request was aborted'), aborted: true })
        return
      }
      logRouterEvent({ type: 'trying', candidate }, log)

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
        logRouterEvent({ type: 'failover', candidate, error: apiKey, cooldownMs: action.cooldownMs }, log)
        attempts.push(`${candidate.provider}/${candidate.modelId}: ${apiKey.message}`)
        continue
      }

      let response: ProviderResponse | undefined
      const usesBearerHeader = candidate.provider === 'minimax' || candidate.provider === 'kimi'
      // pi-ai uses apiKey.includes("sk-ant-oat"), not startsWith.
      const anthropicOAuth = candidate.provider === 'anthropic' && apiKey.includes('sk-ant-oat')
      const routedContext =
        anthropicOAuth && context.systemPrompt
          ? { ...context, systemPrompt: sanitizePiAnthropicSystemPrompt({ text: context.systemPrompt, log }) }
          : context
      const headers = { ...options?.headers }
      if (usesBearerHeader) headers.authorization = `Bearer ${apiKey}`
      if (candidate.provider === 'opencode-go') {
        headers[OPENCODE_GO_SESSION_HEADER] = options?.sessionId || crypto.randomUUID()
      }
      const inner = target.provider.streamSimple(target.model, routedContext, {
        ...options,
        apiKey: usesBearerHeader ? undefined : apiKey,
        headers,
        maxRetries: 0,
        transport: options?.transport,
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
          // Pi only calls onResponse after a successful HTTP response. A 429
          // rejects inside the native provider, so retry-after is not here.
          const action = classifyFailure({
            statusCode: response?.status,
            headers: response?.headers,
            message: event.error.errorMessage ?? 'Provider request failed',
          })
          if (action) await recordCooldown({ candidate, cooldownMs: action.cooldownMs })
          if (action && !committed) {
            const error = new Error(event.error.errorMessage ?? 'Provider request failed')
            logRouterEvent({ type: 'failover', candidate, error, cooldownMs: action.cooldownMs }, log)
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
          const activeRouteKey = options?.sessionId
            ? activeRouteKeys.get(options.sessionId) ?? null
            : null
          if (activeRouteKey === routeKey) affinity.select(routeKey, candidate)
          if (options?.sessionId) {
            await setLiveRoute({
              sessionID: options.sessionId,
              preset: model.id,
              provider: candidate.provider,
              modelId: candidate.modelId,
            })
          }
          model.name = formatCandidateRef(candidate)
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

async function createSubrouterProvider(args: {
  affinity: RouteAffinity
  activeRouteKeys: Map<string, string>
  log?: SubrouterLog
}) {
  const presets = await loadPresets()
  const names = new Set([DEFAULT_PRESET_NAME, ...Object.keys(presets.presets)])
  const resolved = await Promise.all(
    [...names].map(async (preset) => ({ preset, entries: await resolvePresetModels(preset) })),
  )
  const customModelIds = {
    poe: new Set(adapters.poe.defaultModels),
    alibaba: new Set(adapters.alibaba.defaultModels),
    'opencode-go': new Set(adapters['opencode-go'].defaultModels),
  }
  for (const item of resolved) {
    if (item.entries instanceof Error) continue
    for (const entry of item.entries) {
      const parsed = parsePresetEntry(entry)
      if (parsed?.provider === 'poe' || parsed?.provider === 'alibaba' || parsed?.provider === 'opencode-go') {
        customModelIds[parsed.provider].add(parsed.modelId)
      }
    }
  }
  const providers = new Map(builtinProviders().map((provider) => [provider.id, provider]))
  providers.set('zai', createZaiProvider(providers.get('zai')))
  const opencodeGo = createOpenAICompatibleProvider({
    id: 'opencode-go',
    name: 'OpenCode Go',
    baseUrl:
      process.env.SUBROUTER_OPENCODE_GO_BASE_URL?.replace(/\/+$/, '') || 'https://opencode.ai/zen/go/v1',
    envVar: 'OPENCODE_API_KEY',
    modelIds: [...customModelIds['opencode-go']],
  })
  providers.set(opencodeGo.id, opencodeGo)
  const poe = createOpenAICompatibleProvider({
    id: 'poe',
    name: 'Poe',
    baseUrl: process.env.SUBROUTER_POE_BASE_URL?.replace(/\/+$/, '') || 'https://api.poe.com/v1',
    envVar: 'POE_API_KEY',
    modelIds: [...customModelIds.poe],
  })
  providers.set(poe.id, poe)
  const alibaba = createAlibabaProvider({
    source: providers.get('qwen-token-plan'),
    baseUrl:
      process.env.SUBROUTER_ALIBABA_BASE_URL?.replace(/\/+$/, '') ||
      'https://coding-intl.dashscope.aliyuncs.com/v1',
    modelIds: [...customModelIds.alibaba],
  })
  providers.set(alibaba.id, alibaba)
  const models = await Promise.all(
    resolved.map(async ({ preset, entries }) => {
      const model = presetModel({ preset, entries: entries instanceof Error ? [] : entries, providers })
      const candidate = await resolveActiveCandidate(preset)
      if (candidate) model.name = formatCandidateRef(candidate)
      return model
    }),
  )
  return {
    id: PROVIDER_ID,
    name: PROVIDER_DISPLAY_NAME,
    auth: {
      apiKey: {
        name: `${PROVIDER_DISPLAY_NAME} accounts`,
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
    stream: (model, context, options) =>
      streamPreset({
        model,
        context,
        options,
        providers,
        affinity: args.affinity,
        activeRouteKeys: args.activeRouteKeys,
        log: args.log,
      }),
    streamSimple: (model, context, options) =>
      streamPreset({
        model,
        context,
        options,
        providers,
        affinity: args.affinity,
        activeRouteKeys: args.activeRouteKeys,
        log: args.log,
      }),
  } satisfies Provider
}

export default async function subrouterPiExtension(pi: ExtensionAPI) {
  const affinity = new RouteAffinity()
  const activeRouteKeys = new Map<string, string>()
  pi.registerProvider(await createSubrouterProvider({ affinity, activeRouteKeys }))
  pi.on('before_agent_start', (_event, context) => {
    const sessionId = context.sessionManager.getSessionId()
    const previous = activeRouteKeys.get(sessionId)
    if (previous) affinity.clear(previous)
    activeRouteKeys.set(sessionId, crypto.randomUUID())
  })
  pi.on('agent_settled', async (_event, context) => {
    const sessionId = context.sessionManager.getSessionId()
    const routeKey = activeRouteKeys.get(sessionId)
    if (routeKey) affinity.clear(routeKey)
    activeRouteKeys.delete(sessionId)
    await clearLiveRoute(sessionId)
  })
  // The CLI bundle has its own pi-ai copy. This plugin's Codex sockets live
  // here, so CLI session.dispose() cannot close them. Close on shutdown.
  pi.on('session_shutdown', async (_event, context) => {
    const sessionId = context.sessionManager.getSessionId()
    const routeKey = activeRouteKeys.get(sessionId)
    if (routeKey) affinity.clear(routeKey)
    activeRouteKeys.delete(sessionId)
    await clearLiveRoute(sessionId)
    closeOpenAICodexWebSocketSessions()
  })
}
