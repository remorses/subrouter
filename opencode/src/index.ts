/**
 * OpenCode plugin that registers the `subrouter` provider.
 *
 * The config hook injects a custom provider whose npm field points at this
 * package's provider module (file:// URL, so opencode never installs anything).
 * Each subrouter preset becomes a model: pick `subrouter/default` (or any
 * preset created with `subrouter preset create`) in opencode.
 *
 * NOTE: only plugin initializer functions may be exported from this module.
 * OpenCode calls every export as a plugin.
 */

import type { Plugin } from '@opencode-ai/plugin'
import { DEFAULT_PRESET_NAME, loadPresets } from '@subrouter/cli'

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
  }
}
