/**
 * Provider entry loaded by OpenCode v2 via `aisdk:file://...`.
 * The catalog package must export `model(modelID, settings)` so v2 can
 * construct RouterModel while keeping preset ids stable.
 */

import {
  DEFAULT_PRESET_NAME,
  OPENCODE_AGENT_HEADER,
  OPENCODE_VARIANT_HEADER,
  OPENAI_WEBSOCKET_SESSION_HEADER,
  OPENAI_WEBSOCKET_TITLE_HEADER,
  PROVIDER_DISPLAY_NAME,
  PROVIDER_ID,
  RouteAffinity,
  createSubrouter as createSubrouterEngine,
  loadModelsDevCatalog,
  loadPresets,
  modelsDevInputModalities,
  modelsDevLimit,
  modelsDevModel,
  resolveCandidates,
  resolveLiveModel,
  resolvePresetModels,
  ROUTE_AFFINITY_HEADER,
  variantProviderOptions,
} from '@subrouter/cli'

const affinity = new RouteAffinity()

export function createSubrouter(
  options: {
    affinity?: RouteAffinity
  } = {},
) {
  return createSubrouterEngine({
    affinity: options.affinity ?? affinity,
  })
}

const POWERED_BY_MODEL = /You are powered by the model named [^\n]+/

export type PresetCatalogModel = {
  name: string
  reasoning: boolean
  limit: { context: number; input?: number; output: number }
  capabilities: {
    tools: true
    input: Array<'text' | 'audio' | 'image' | 'video' | 'pdf'>
    output: Array<'text'>
  }
  variants: Array<{ id: string; settings: object }>
}

export type PresetCatalog = {
  provider: { name: string; package: string }
  models: Record<string, PresetCatalogModel>
}

export function providerEntryUrl() {
  const isDev = import.meta.url.endsWith('.ts')
  return new URL(isDev ? './provider.ts' : './provider.js', import.meta.url).href
}

export function providerPackage() {
  return `aisdk:${providerEntryUrl()}`
}

export function rewritePoweredByModelLine({
  system,
  candidate,
}: {
  system: string[]
  candidate: { provider: string; modelId: string }
}) {
  const line = `You are powered by the model named ${candidate.modelId}. The exact model ID is ${candidate.provider}/${candidate.modelId}`
  for (let i = 0; i < system.length; i++) {
    system[i] = system[i]!.replace(POWERED_BY_MODEL, line)
  }
}

export async function revealRoutedModel({
  providerID,
  preset,
  sessionID,
  system,
}: {
  providerID: string
  preset: string
  sessionID?: string
  system: string[]
}) {
  if (providerID !== PROVIDER_ID) return
  const candidate = await resolveLiveModel({ preset, sessionID })
  if (!candidate) return
  rewritePoweredByModelLine({ system, candidate })
}

export function addSubrouterHeaders({
  sessionID,
  agent,
  kind,
  model,
  headers,
}: {
  sessionID: string
  agent: string
  kind: string
  model: { providerID: string; id: string; variant?: string }
  headers: Record<string, string>
}) {
  if (model.providerID !== PROVIDER_ID) return
  headers[OPENAI_WEBSOCKET_SESSION_HEADER] = sessionID
  if (kind === 'title') {
    headers[OPENAI_WEBSOCKET_TITLE_HEADER] = 'true'
    return
  }
  if (kind !== 'primary') return
  headers[ROUTE_AFFINITY_HEADER] = sessionID
  headers[OPENCODE_AGENT_HEADER] = agent
  if (model.variant) headers[OPENCODE_VARIANT_HEADER] = model.variant
}

export async function loadPresetCatalog(): Promise<PresetCatalog> {
  const presets = await loadPresets().catch(() => {
    return { version: 1 as const, presets: {} }
  })
  const names = new Set([DEFAULT_PRESET_NAME, ...Object.keys(presets.presets)])
  const catalog = await loadModelsDevCatalog()
  const resolved = await Promise.all(
    [...names].map(async (name) => {
      const presetModels = await resolvePresetModels(name)
      const candidates =
        presetModels instanceof Error
          ? []
          : (await resolveCandidates({ presetModels })).candidates
      const candidate = candidates[0]
      const limit = candidate
        ? modelsDevLimit({
            provider: candidate.provider,
            modelId: candidate.modelId,
            catalog,
          })
        : null
      const input = new Set<'text' | 'audio' | 'image' | 'video' | 'pdf'>(['text'])
      for (const current of candidates) {
        const modalities = modelsDevInputModalities({
          provider: current.provider,
          modelId: current.modelId,
          catalog,
        })
        if (!modalities) continue
        for (const modality of modalities) input.add(modality)
      }
      return { name, candidate, input, limit }
    }),
  )
  const models = Object.fromEntries(
    resolved.map(({ name, candidate, input, limit }) => {
      const catalogModel = candidate
        ? modelsDevModel({
            provider: candidate.provider,
            modelId: candidate.modelId,
            catalog,
          })
        : null
      const variants = candidate
        ? (catalogModel?.variants ?? []).map((variant) => ({
            id: variant,
            settings: variantProviderOptions({
              provider: candidate.provider,
              modelId: candidate.modelId,
              variant,
            }),
          }))
        : []
      const model: PresetCatalogModel = {
        name,
        reasoning: catalogModel?.reasoning ?? false,
        capabilities: {
          tools: true,
          input: [...input],
          output: ['text'],
        },
        variants,
        limit: limit ?? { context: 200_000, output: 64_000 },
      }
      return [name, model]
    }),
  )
  return {
    provider: {
      name: PROVIDER_DISPLAY_NAME,
      package: providerPackage(),
    },
    models,
  }
}

export function routeAffinity() {
  return affinity
}

export function model(modelID: string) {
  return createSubrouter({ affinity }).languageModel(modelID)
}
