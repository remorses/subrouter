/**
 * OpenCode Zen (opencode Go subscription) adapter.
 *
 * OpenCode Zen is an OpenAI-compatible gateway at https://opencode.ai/zen/v1
 * authenticated with an API key from console.opencode.ai. Login stores the
 * pasted key; the request path injects it as a bearer token.
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import * as errore from 'errore'
import type { StoredAccount } from '../store.ts'
import { resolveBaseUrl, type LoginArgs, type ProviderAdapter } from './index.ts'

export class OpencodeAuthError extends errore.createTaggedError({
  name: 'OpencodeAuthError',
  message: 'OpenCode Zen auth failed: $reason',
}) {}

async function login(args: LoginArgs): Promise<Error | StoredAccount> {
  args.log('Get an API key from https://console.opencode.ai (opencode Go subscription), then paste it here.')
  await args.openUrl('https://console.opencode.ai')
  if (!args.promptManualInput) {
    return new OpencodeAuthError({ reason: 'opencode login requires pasting an API key interactively' })
  }
  const key = await args.promptManualInput()
  if (!key?.trim()) return new OpencodeAuthError({ reason: 'no API key provided' })
  const now = Date.now()
  return {
    type: 'api',
    key: key.trim(),
    addedAt: now,
    lastUsed: now,
  }
}

export const opencodeAdapter: ProviderAdapter = {
  id: 'opencode',
  name: 'OpenCode Zen (opencode Go)',
  defaultModels: ['grok-4.6', 'gemini-3.7-flash'],
  baseUrlEnvVar: 'SUBROUTER_OPENCODE_BASE_URL',
  createModel({ modelId, account }) {
    const provider = createOpenAICompatible({
      name: 'opencode',
      apiKey: account.key || 'subrouter-missing-key',
      baseURL: resolveBaseUrl({
        envVar: this.baseUrlEnvVar,
        fallback: 'https://opencode.ai/zen/v1',
      }),
      includeUsage: true,
    })
    return provider.languageModel(modelId)
  },
  login,
}
