/**
 * Provider entry loaded by opencode via `provider.subrouter.npm` (file:// URL).
 * OpenCode imports this module, calls the first export starting with `create`,
 * then `sdk.languageModel(modelId)` where modelId is a subrouter preset name.
 */

import {
  OPENAI_WEBSOCKET_SESSION_HEADER,
  OPENAI_WEBSOCKET_TITLE_HEADER,
} from '@subrouter/cli'

export { createSubrouter } from '@subrouter/cli'

export function addSubrouterHeaders(
  input: { sessionID: string; agent: string; model: { providerID: string } },
  output: { headers: Record<string, string> },
) {
  if (input.model.providerID !== 'subrouter') return
  output.headers[OPENAI_WEBSOCKET_SESSION_HEADER] = input.sessionID
  if (input.agent === 'title') output.headers[OPENAI_WEBSOCKET_TITLE_HEADER] = 'true'
}
