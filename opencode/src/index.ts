/**
 * OpenCode plugins that expose subrouter inside opencode.
 *
 * `subrouterPlugin` registers the provider: the config hook injects a custom
 * provider whose npm field points at this package's provider module (file://
 * URL, so opencode never installs anything). Each subrouter preset becomes a
 * model: pick `subrouter/default` (or any preset created with
 * `subrouter preset create`) in opencode.
 *
 * `subrouterAuthPlugin` registers the login flow, so `opencode auth login`
 * (and any harness driving opencode's auth hook, like kimaki's Discord
 * `/login`) can add subscriptions to the pool without leaving the harness.
 * It asks which subscription to add first, then defers to that adapter.
 *
 * NOTE: only plugin initializer functions may be exported from this module.
 * OpenCode calls every export as a plugin.
 */

import type { Plugin } from '@opencode-ai/plugin'
import {
  adapters,
  addAccount,
  DEFAULT_PRESET_NAME,
  isProviderId,
  loadPresets,
  PROVIDER_IDS,
  type StoredAccount,
} from '@subrouter/cli'
import { addSubrouterHeaders } from './provider.ts'

function providerEntryUrl() {
  const isDev = import.meta.url.endsWith('.ts')
  return new URL(isDev ? './provider.ts' : './provider.js', import.meta.url).href
}

export const subrouterPlugin: Plugin = async () => {
  return {
    config: async (config) => {
      const presets = await loadPresets().catch(() => {
        return { version: 1 as const, presets: {} }
      })
      const names = new Set([DEFAULT_PRESET_NAME, ...Object.keys(presets.presets)])
      const models = Object.fromEntries(
        [...names].map((name) => [
          name,
          {
            name: `subrouter ${name}`,
            tool_call: true,
            attachment: false,
            reasoning: false,
            cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
            limit: { context: 200_000, output: 64_000 },
          },
        ]),
      )
      config.provider = {
        ...config.provider,
        subrouter: {
          name: 'Subrouter',
          npm: providerEntryUrl(),
          models,
          options: {},
        },
      }
    },
    'chat.headers': async (input, output) => addSubrouterHeaders(input, output),
  }
}

/**
 * Map a subrouter account onto the credential shape opencode stores. The
 * stored copy is redundant (RouterModel only ever reads ~/.subrouter), but
 * opencode needs a success payload to close the login flow.
 */
function toOpencodeCredentials(account: StoredAccount) {
  if (account.type === 'api') {
    return { type: 'success' as const, key: account.key ?? '' }
  }
  return {
    type: 'success' as const,
    refresh: account.refresh ?? '',
    access: account.access ?? '',
    expires: account.expires ?? 0,
    accountId: account.accountId,
  }
}

export const subrouterAuthPlugin: Plugin = async () => {
  return {
    auth: {
      provider: 'subrouter',
      methods: [
        {
          type: 'oauth',
          label: 'Add a subscription',
          prompts: [
            {
              type: 'select',
              key: 'provider',
              message: 'Which subscription do you want to add?',
              options: PROVIDER_IDS.map((id) => {
                return { label: adapters[id].name, value: id }
              }),
            },
            {
              type: 'select',
              key: 'method',
              message: 'How do you want to log in to ChatGPT?',
              options: [
                { label: 'Browser (recommended)', value: 'browser' },
                { label: 'Device code', value: 'device', hint: 'May be disabled for your account' },
              ],
              when: { key: 'provider', op: 'eq', value: 'openai' },
            },
          ],
          authorize: async (inputs) => {
            const providerId = inputs?.provider
            if (!providerId || !isProviderId(providerId)) {
              // No failure variant exists in AuthOAuthResult, so surface this
              // as a request error instead. Harnesses render the message.
              throw new Error(
                `Pick a subscription to add. Expected one of: ${PROVIDER_IDS.join(', ')}`,
              )
            }

            const adapter = adapters[providerId]
            // Remote harnesses (a chat bot, a web UI) authorize in a browser
            // that is not on this machine, so a localhost callback never fires
            // and the user has to paste the redirect URL back instead.
            const session = await adapter.beginLogin({
              manualInput: Boolean(process.env.SUBROUTER_MANUAL_OAUTH),
              method: inputs?.method,
            })
            if (session instanceof Error) throw session

            const finish = async (input?: string) => {
              const account = await session.complete(input)
              if (account instanceof Error) return { type: 'failed' as const }
              await addAccount({ provider: providerId, account })
              return toOpencodeCredentials(account)
            }

            if (session.method === 'code') {
              return {
                url: session.url,
                instructions: session.instructions,
                method: 'code' as const,
                callback: (code) => finish(code),
              }
            }
            return {
              url: session.url,
              instructions: session.instructions,
              method: 'auto' as const,
              callback: () => finish(),
            }
          },
        },
      ],
    },
  }
}
