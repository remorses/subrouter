/**
 * OpenCode plugins that expose subrouter inside opencode.
 *
 * `subrouterPlugin` registers the provider: the config hook injects a custom
 * provider whose npm field points at this package's provider module (file://
 * URL, so opencode never installs anything). Each subrouter preset becomes a
 * model: pick `subrouter/default` (or any preset created with
 * `subrouter preset create`) in opencode. Provider id stays `subrouter`; the
 * visible name is `subrouter.org`. Context limits follow the first live
 * candidate. Input modalities cover every usable candidate so the
 * router can select a compatible subscription for each prompt. Tool
 * follow-ups stay on the selected route until the session becomes idle.
 *
 * `subrouterAuthPlugin` registers the login flow, so `opencode auth login`
 * (and any harness driving opencode's auth hook, like kimaki's Discord
 * `/login`) can add subscriptions to the pool without leaving the harness.
 * It asks which subscription to add first, then defers to that adapter.
 *
 * NOTE: only plugin initializer functions may be exported from this module.
 * OpenCode calls every export as a plugin.
 */

import type { Plugin, PluginInput } from '@opencode-ai/plugin'
import {
  adapters,
  addAccount,
  DEFAULT_PRESET_NAME,
  isProviderId,
  loadModelsDevCatalog,
  loadPresets,
  modelsDevInputModalities,
  modelsDevLimit,
  modelsDevModel,
  PROVIDER_DISPLAY_NAME,
  PROVIDER_ID,
  PROVIDER_IDS,
  resolveCandidates,
  resolvePresetModels,
  RouteAffinity,
  type CooldownFallbackNotice,
  type StoredAccount,
  type SubrouterLog,
} from '@subrouter/cli'
import { addSubrouterHeaders, revealRoutedModel } from './provider.ts'

function providerEntryUrl() {
  const isDev = import.meta.url.endsWith('.ts')
  return new URL(isDev ? './provider.ts' : './provider.js', import.meta.url).href
}

function opencodeLog(client: PluginInput['client'] | undefined): SubrouterLog | undefined {
  if (!client?.app?.log) return undefined
  const write = client.app.log.bind(client.app)
  return (entry) => {
    void write({
      body: {
        service: 'subrouter',
        level: entry.level,
        message: entry.message,
        extra: entry.extra,
      },
    }).catch(() => {})
  }
}

export const subrouterPlugin: Plugin = async ({ client, directory }) => {
  const log = opencodeLog(client)
  const affinity = new RouteAffinity()
  const activeMessages = new Map<string, string>()
  const deliveredNotices = new Map<string, { text: string; expiresAt: number }>()
  const onCooldownFallback = async (notice: CooldownFallbackNotice) => {
    if (!notice.sessionID || !notice.agent || notice.agent === 'title') return
    const preferred = `${notice.preferred.provider}/${notice.preferred.modelId}`
    const active = `${notice.active.provider}/${notice.active.modelId}`
    const text = `Subrouter: Using ${active} because ${preferred} is rate limited.`
    const delivered = deliveredNotices.get(notice.sessionID)
    if (delivered?.text === text && delivered.expiresAt > Date.now()) return
    const current = { text, expiresAt: Date.now() + notice.preferred.retryAfterMs }
    deliveredNotices.set(notice.sessionID, current)
    const body = {
      noReply: true,
      agent: notice.agent,
      model: { providerID: PROVIDER_ID, modelID: notice.preset },
      variant: notice.variant,
      parts: [{ type: 'text' as const, text, ignored: true }],
    }
    const result = await client.session
      .prompt({
        path: { id: notice.sessionID },
        query: { directory },
        body,
        throwOnError: true,
      })
      .catch((cause) => new Error('failed to persist cooldown fallback notice', { cause }))
    if (!(result instanceof Error)) return
    if (deliveredNotices.get(notice.sessionID) === current) {
      deliveredNotices.delete(notice.sessionID)
    }
    void log?.({ level: 'warn', message: result.message })
  }
  return {
    config: async (config) => {
      const presets = await loadPresets().catch(() => {
        return { version: 1 as const, presets: {} }
      })
      const names = new Set([DEFAULT_PRESET_NAME, ...Object.keys(presets.presets)])
      const catalog = await loadModelsDevCatalog({ log })
      const models = Object.fromEntries(
        await Promise.all(
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
            let attachment = false
            for (const current of candidates) {
              const model = modelsDevModel({
                provider: current.provider,
                modelId: current.modelId,
                catalog,
              })
              const modalities = modelsDevInputModalities({
                provider: current.provider,
                modelId: current.modelId,
                catalog,
              })
              if (!model || !modalities) continue
              attachment ||= model.attachment && modalities.some((modality) => modality !== 'text')
              for (const modality of modalities) input.add(modality)
            }
            return [
              name,
              {
                name,
                tool_call: true,
                attachment,
                reasoning: false,
                modalities: {
                  input: [...input],
                  output: ['text'] satisfies Array<'text'>,
                },
                cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
                limit: limit ?? { context: 200_000, output: 64_000 },
              },
            ]
          }),
        ),
      )
      config.provider = {
        ...config.provider,
        [PROVIDER_ID]: {
          name: PROVIDER_DISPLAY_NAME,
          npm: providerEntryUrl(),
          models,
          options: { affinity, log, onCooldownFallback },
        },
      }
    },
    event: async ({ event }) => {
      if (event.type === 'session.deleted') {
        const sessionID = event.properties.info.id
        const messageID = activeMessages.get(sessionID)
        if (messageID) affinity.clear(messageID)
        activeMessages.delete(sessionID)
        deliveredNotices.delete(sessionID)
        return
      }
      if (event.type !== 'session.idle') return
      const sessionID = event.properties.sessionID
      const messageID = activeMessages.get(sessionID)
      if (messageID) affinity.clear(messageID)
      activeMessages.delete(sessionID)
    },
    'chat.headers': async (input, output) => {
      const activeMessage = activeMessages.get(input.sessionID) ?? input.message.id
      const affinityKey = addSubrouterHeaders({ input, output, affinityKey: activeMessage })
      if (affinityKey) activeMessages.set(input.sessionID, affinityKey)
    },
    // This runs before chat.headers, so a turn's first call has no affinity key.
    'experimental.chat.system.transform': async (input, output) => {
      await revealRoutedModel({
        providerID: input.model.providerID,
        preset: input.model.id,
        affinity,
        affinityKey: input.sessionID ? activeMessages.get(input.sessionID) : undefined,
        system: output.system,
      })
    },
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
      provider: PROVIDER_ID,
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
