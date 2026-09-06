/**
 * OpenCode Go subscription adapter.
 *
 * OpenCode Go is the $10/month subscription at https://opencode.ai/zen/go/v1.
 * models.dev id is `opencode-go`. Do not use `opencode` / zen/v1: that is Zen
 * pay-as-you-go, a different product with a different catalog.
 *
 * Login stores an API key from https://opencode.ai/auth. Requests inject it as a
 * bearer token. OpenCode Go also requires `x-opencode-session` (stable per
 * conversation); RouterModel / Pi set that from the harness session id.
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import * as errore from 'errore'
import type { StoredAccount } from '../store.ts'
import { resolveBaseUrl, type LoginSession, type ProviderAdapter } from './index.ts'

export const OPENCODE_GO_SESSION_HEADER = 'x-opencode-session'

export class OpencodeGoAuthError extends errore.createTaggedError({
  name: 'OpencodeGoAuthError',
  message: 'OpenCode Go auth failed: $reason',
}) {}

async function beginLogin(): Promise<Error | LoginSession> {
  return {
    url: 'https://opencode.ai/auth',
    instructions:
      'Copy your API key from https://opencode.ai/auth (OpenCode Go subscription), then paste it back here.',
    method: 'code',
    async complete(input) {
      const key = input?.trim()
      if (!key) return new OpencodeGoAuthError({ reason: 'no API key provided' })
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

export const opencodeGoAdapter: ProviderAdapter = {
  id: 'opencode-go',
  name: 'OpenCode Go',
  defaultModels: ['grok-4.6', 'glm-5.3-flash'],
  baseUrlEnvVar: 'SUBROUTER_OPENCODE_GO_BASE_URL',
  createModel({ modelId, account }) {
    const provider = createOpenAICompatible({
      name: 'opencode-go',
      apiKey: account.key || 'subrouter-missing-key',
      baseURL: resolveBaseUrl({
        envVar: this.baseUrlEnvVar,
        fallback: 'https://opencode.ai/zen/go/v1',
      }),
      includeUsage: true,
    })
    return provider.languageModel(modelId)
  },
  async getApiKey({ account }) {
    if (account.key) return account.key
    return new OpencodeGoAuthError({ reason: 'account has no API key' })
  },
  beginLogin,
}
