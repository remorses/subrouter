/**
 * Provider entry loaded by opencode via `provider.subrouter.npm` (file:// URL).
 * OpenCode imports this module, calls the first export starting with `create`,
 * then `sdk.languageModel(modelId)` where modelId is a subrouter preset name.
 * Also rewrites OpenCode's powered-by identity to the live routed model.
 */

import {
  OPENCODE_AGENT_HEADER,
  OPENCODE_VARIANT_HEADER,
  OPENAI_WEBSOCKET_SESSION_HEADER,
  OPENAI_WEBSOCKET_TITLE_HEADER,
  PROVIDER_ID,
  resolveActiveCandidate,
} from '@subrouter/cli'

export { createSubrouter } from '@subrouter/cli'

const POWERED_BY_MODEL = /You are powered by the model named [^\n]+/

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
  system,
}: {
  providerID: string
  preset: string
  system: string[]
}) {
  if (providerID !== PROVIDER_ID) return
  const candidate = await resolveActiveCandidate(preset)
  if (!candidate) return
  rewritePoweredByModelLine({ system, candidate })
}

export function addSubrouterHeaders(
  input: {
    sessionID: string
    agent: string
    model: { providerID: string }
    message: {
      agent: string
      model: { providerID: string; modelID: string; variant?: string }
    }
  },
  output: { headers: Record<string, string> },
) {
  if (input.model.providerID !== PROVIDER_ID) return
  output.headers[OPENAI_WEBSOCKET_SESSION_HEADER] = input.sessionID
  if (input.agent === input.message.agent) {
    output.headers[OPENCODE_AGENT_HEADER] = input.message.agent
    if (input.message.model.variant) {
      output.headers[OPENCODE_VARIANT_HEADER] = input.message.model.variant
    }
  }
  if (input.agent === 'title') output.headers[OPENAI_WEBSOCKET_TITLE_HEADER] = 'true'
}
