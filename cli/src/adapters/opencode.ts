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
import { resolveBaseUrl, type LoginSession, type ProviderAdapter } from './index.ts'

export class OpencodeAuthError extends errore.createTaggedError({
  name: 'OpencodeAuthError',
  message: 'OpenCode Zen auth failed: $reason',
}) {}

async function beginLogin(): Promise<Error | LoginSession> {
  return {
    url: 'https://console.opencode.ai',
    instructions:
      'Copy your API key from console.opencode.ai (opencode Go subscription), then paste it back here.',
    method: 'code',
    async complete(input) {
      const key = input?.trim()
      if (!key) return new OpencodeAuthError({ reason: 'no API key provided' })
      const now = Date.now()
      return {
        type: 'api',
        key,
        addedAt: now,
        lastUsed: now,
      } satisfies StoredAccount
    },
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
  async getApiKey({ account }) {
    if (account.key) return account.key
    return new OpencodeAuthError({ reason: 'account has no API key' })
  },
  beginLogin,
}
