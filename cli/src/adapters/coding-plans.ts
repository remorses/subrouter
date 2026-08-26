/** API-key adapters for subscription coding plans with standard AI wire formats. */

import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import * as errore from 'errore'
import type { ProviderId, StoredAccount } from '../store.ts'
import { resolveBaseUrl, type LoginSession, type ProviderAdapter } from './index.ts'

export class CodingPlanAuthError extends errore.createTaggedError({
  name: 'CodingPlanAuthError',
  message: '$provider auth failed: $reason',
}) {}

type CodingPlanConfig = {
  id: ProviderId
  name: string
  protocol: 'anthropic' | 'openai-compatible'
  defaultModels: string[]
  baseUrlEnvVar: string
  baseUrl: string
  accountUrl: string
}

function getApiKey({ account, provider }: { account: StoredAccount; provider: ProviderId }) {
  if (account.key) return account.key
  return new CodingPlanAuthError({ provider, reason: 'account has no subscription key' })
}

function createCodingPlanAdapter(config: CodingPlanConfig): ProviderAdapter {
  return {
    id: config.id,
    name: config.name,
    defaultModels: config.defaultModels,
    baseUrlEnvVar: config.baseUrlEnvVar,
    createModel({ modelId, account }) {
      const key = account.key || 'subrouter-missing-key'
      const baseURL = resolveBaseUrl({ envVar: config.baseUrlEnvVar, fallback: config.baseUrl })
      if (config.protocol === 'anthropic') {
        return createAnthropic({ authToken: key, baseURL }).languageModel(modelId)
      }
      return createOpenAICompatible({
        name: config.id,
        apiKey: key,
        baseURL,
        includeUsage: true,
      }).languageModel(modelId)
    },
    async getApiKey({ account }) {
      return getApiKey({ account, provider: config.id })
    },
    async beginLogin(): Promise<Error | LoginSession> {
      let pending: Promise<Error | StoredAccount> | undefined
      return {
        url: config.accountUrl,
        instructions: `Copy your ${config.name} subscription key, then paste it here.`,
        method: 'code',
        complete(input) {
          pending ??= (async () => {
            const key = input?.trim()
            if (!key) {
              return new CodingPlanAuthError({
                provider: config.id,
                reason: 'no subscription key provided',
              })
            }
            const now = Date.now()
            return {
              type: 'api',
              key,
              addedAt: now,
              lastUsed: now,
            } satisfies StoredAccount
          })()
          return pending
        },
      }
    },
  }
}

export const minimaxAdapter = createCodingPlanAdapter({
  id: 'minimax',
  name: 'MiniMax Token Plan',
  protocol: 'anthropic',
  defaultModels: ['MiniMax-M3', 'MiniMax-M2.7'],
  baseUrlEnvVar: 'SUBROUTER_MINIMAX_BASE_URL',
  baseUrl: 'https://api.minimax.io/anthropic/v1',
  accountUrl: 'https://platform.minimax.io/subscribe/token-plan',
})

export const kimiAdapter = createCodingPlanAdapter({
  id: 'kimi',
  name: 'Kimi Code',
  protocol: 'anthropic',
  defaultModels: ['k3', 'kimi-for-coding'],
  baseUrlEnvVar: 'SUBROUTER_KIMI_BASE_URL',
  baseUrl: 'https://api.kimi.com/coding/v1',
  accountUrl: 'https://www.kimi.com/code',
})

export const zaiAdapter = createCodingPlanAdapter({
  id: 'zai',
  name: 'Z.ai GLM Coding Plan',
  protocol: 'openai-compatible',
  defaultModels: ['glm-5.3', 'glm-5.3-highspeed'],
  baseUrlEnvVar: 'SUBROUTER_ZAI_BASE_URL',
  baseUrl: 'https://api.z.ai/api/coding/paas/v4',
  accountUrl: 'https://z.ai/subscribe',
})

export const alibabaAdapter = createCodingPlanAdapter({
  id: 'alibaba',
  name: 'Alibaba Coding Plan',
  protocol: 'openai-compatible',
  defaultModels: ['qwen3.7-plus', 'qwen3.7-max'],
  baseUrlEnvVar: 'SUBROUTER_ALIBABA_BASE_URL',
  baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1',
  accountUrl: 'https://modelstudio.console.alibabacloud.com/',
})
