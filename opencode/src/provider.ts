/**
 * Provider entry loaded by opencode via `provider.subrouter.npm` (file:// URL).
 * OpenCode imports this module, calls the first export starting with `create`,
 * then `sdk.languageModel(modelId)`. For GPT presets that id is a spoofed
 * `gpt-*` api id so OpenCode prefers apply_patch; createSubrouter maps it
 * back to the preset. Also rewrites OpenCode's powered-by identity to the
 * live routed model and appends the GPT apply_patch constraint when needed.
 */

import {
  OPENCODE_AGENT_HEADER,
  OPENCODE_VARIANT_HEADER,
  OPENAI_WEBSOCKET_SESSION_HEADER,
  OPENAI_WEBSOCKET_TITLE_HEADER,
  PROVIDER_ID,
  resolveLiveModel,
  ROUTE_AFFINITY_HEADER,
} from '@subrouter/cli'

export { createSubrouter } from '@subrouter/cli'

const POWERED_BY_MODEL = /You are powered by the model named [^\n]+/

// OpenCode v1 registry.ts and v2 patch.ts: GPT (not gpt-4 / gpt-oss) uses apply_patch.
export function shouldUseApplyPatch(modelId: string) {
  return modelId.includes('gpt-') && !modelId.includes('oss') && !modelId.includes('gpt-4')
}

export function applyPatchApiId({
  preset,
  modelId,
  taken,
}: {
  preset: string
  modelId: string
  taken: Set<string>
}) {
  if (!taken.has(modelId)) return modelId
  return `${modelId}:${preset}`
}

const APPLY_PATCH_GPT =
  'Always use apply_patch for manual code edits. Do not use cat or any other commands when creating or editing files. Formatting commands or bulk edits don\'t need to be done with apply_patch.'

const APPLY_PATCH_CODEX =
  'Try to use apply_patch for single file edits, but it is fine to explore other options to make the edit if it does not work well. Do not use apply_patch for changes that are auto-generated (i.e. generating package.json or running a lint or format command like gofmt) or when scripting is more efficient (such as search and replacing a string across a codebase).'

export function applyPatchConstraint(modelId: string) {
  if (modelId.includes('codex')) return APPLY_PATCH_CODEX
  return APPLY_PATCH_GPT
}

export function appendApplyPatchConstraint({
  system,
  modelId,
}: {
  system: string[]
  modelId: string
}) {
  if (!shouldUseApplyPatch(modelId)) return
  const constraint = applyPatchConstraint(modelId)
  if (system.some((line) => line.includes('use apply_patch'))) return
  system.push(constraint)
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
  appendApplyPatchConstraint({ system, modelId: candidate.modelId })
}

export function addSubrouterHeaders({
  input,
  output,
  affinityKey = input.message.id,
}: {
  input: {
    sessionID: string
    agent: string
    model: { providerID: string }
    message: {
      id: string
      agent: string
      model: { providerID: string; modelID: string; variant?: string }
    }
  }
  output: { headers: Record<string, string> }
  affinityKey?: string
}) {
  if (input.model.providerID !== PROVIDER_ID) return null
  output.headers[OPENAI_WEBSOCKET_SESSION_HEADER] = input.sessionID
  if (input.agent === input.message.agent) {
    output.headers[ROUTE_AFFINITY_HEADER] = affinityKey
    output.headers[OPENCODE_AGENT_HEADER] = input.message.agent
    if (input.message.model.variant) {
      output.headers[OPENCODE_VARIANT_HEADER] = input.message.model.variant
    }
  }
  if (input.agent === 'title') output.headers[OPENAI_WEBSOCKET_TITLE_HEADER] = 'true'
  return output.headers[ROUTE_AFFINITY_HEADER] ?? null
}
