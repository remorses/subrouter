/**
 * OpenCode v2 plugin that exposes subrouter.
 *
 * Default export is Plugin.define({ id: 'subrouter' }). Setup registers the
 * catalog, OAuth login, model.request headers, context rewrite, and live-route
 * cleanup. API-key providers stay on the CLI; OpenCode login is OAuth only.
 */

import { Credential, Integration, Model, Plugin } from '@opencode/plugin'
import {
  adapters,
  addAccount,
  clearLiveRoute,
  isProviderId,
  PROVIDER_ID,
  type ProviderId,
  type StoredAccount,
} from '@subrouter/cli'
import {
  addSubrouterHeaders,
  loadPresetCatalog,
  revealRoutedModel,
  routeAffinity,
} from './provider.ts'

const OAUTH_PROVIDER_IDS = ['anthropic', 'openai', 'xai', 'github-copilot', 'poe'] as const
const OAUTH_METHOD_ID = 'login'

export const oauthProviderIds: ProviderId[] = [...OAUTH_PROVIDER_IDS]

function toOauthCredential({
  methodID,
  account,
}: {
  methodID: string
  account: StoredAccount
}): Credential.OAuth {
  const metadata: Record<string, string> = {}
  if (account.email) metadata.email = account.email
  if (account.accountId) metadata.accountId = account.accountId
  return {
    type: 'oauth',
    methodID: Integration.MethodID.make(methodID),
    refresh: account.refresh ?? '',
    access: account.access ?? '',
    expires: account.expires ?? 0,
    metadata,
  }
}

export async function authorizeSubrouterLogin(answer: {
  provider?: string | number | boolean | string[]
  method?: string | number | boolean | string[]
}) {
  const providerId = typeof answer.provider === 'string' ? answer.provider : undefined
  if (!providerId || !isProviderId(providerId) || !OAUTH_PROVIDER_IDS.some((id) => id === providerId)) {
    throw new Error(
      `Pick a subscription to add. OpenCode login supports OAuth only: ${OAUTH_PROVIDER_IDS.join(', ')}. Use \`subrouter login\` for API-key providers.`,
    )
  }
  const adapter = adapters[providerId]
  const method = typeof answer.method === 'string' ? answer.method : undefined
  const session = await adapter.beginLogin({
    manualInput: true,
    method,
  })
  if (session instanceof Error) throw session
  const finish = async (input?: string) => {
    const account = await session.complete(input)
    if (account instanceof Error) throw account
    await addAccount({ provider: providerId, account })
    return toOauthCredential({ methodID: OAUTH_METHOD_ID, account })
  }
  if (session.method === 'code') {
    return {
      url: session.url,
      instructions: session.instructions,
      mode: 'code' as const,
      callback: (code: string) => finish(code),
    }
  }
  return {
    url: session.url,
    instructions: session.instructions,
    mode: 'auto' as const,
    callback: finish(),
  }
}

export default Plugin.define({
  id: 'subrouter',
  setup: async (ctx) => {
    await using registrations = new AsyncDisposableStack()
    const directory = ctx.location.directory
    const workspaceID = ctx.location.workspaceID
    const ownedSessions = new Set<string>()
    const catalog = await loadPresetCatalog()
    const catalogRegistration = await ctx.catalog.transform((editor) => {
      editor.provider.update(PROVIDER_ID, (provider) => {
        provider.name = catalog.provider.name
        provider.package = catalog.provider.package
        provider.activation = 'enabled'
      })
      for (const [preset, model] of Object.entries(catalog.models)) {
        editor.model.update(PROVIDER_ID, preset, (draft) => {
          draft.name = model.name
          draft.package = catalog.provider.package
          draft.limit = model.limit
          draft.capabilities = model.capabilities
          draft.variants = model.variants.map((variant) => ({
            id: Model.VariantID.make(variant.id),
            settings: variant.settings,
          }))
          draft.status = 'active'
          draft.enabled = true
        })
      }
    })
    registrations.defer(() => catalogRegistration.dispose())
    const integrationRegistration = await ctx.integration.transform((editor) => {
      editor.update(PROVIDER_ID, (integration) => {
        integration.name = catalog.provider.name
      })
      editor.method.update({
        integrationID: PROVIDER_ID,
        method: {
          id: OAUTH_METHOD_ID,
          type: 'oauth',
          label: 'Add a subscription',
          form: [
            {
              key: 'provider',
              type: 'string',
              title: 'Which subscription do you want to add?',
              options: oauthProviderIds.map((id) => ({
                value: id,
                label: adapters[id].name,
              })),
            },
            {
              key: 'method',
              type: 'string',
              title: 'How do you want to log in to ChatGPT?',
              options: [
                { value: 'browser', label: 'Browser (recommended)' },
                { value: 'device', label: 'Device code' },
              ],
              when: [{ key: 'provider', op: 'eq', value: 'openai' }],
            },
          ],
        },
        authorize: (answer) => authorizeSubrouterLogin(answer),
      })
    })
    registrations.defer(() => integrationRegistration.dispose())
    const requestRegistration = await ctx.session.hook(
      'model.request',
      (event) => {
        if (event.kind === 'primary') ownedSessions.add(event.sessionID)
        addSubrouterHeaders(event)
      },
      { providerID: PROVIDER_ID },
    )
    registrations.defer(() => requestRegistration.dispose())
    const contextRegistration = await ctx.session.hook(
      'context',
      async (event) => {
        const textParts = event.system.filter(
          (part): part is { type: 'text'; text: string } => part.type === 'text',
        )
        const system = textParts.map((part) => part.text)
        await revealRoutedModel({
          providerID: event.model.providerID,
          preset: event.model.id,
          sessionID: event.sessionID,
          system,
        })
        textParts.forEach((part, index) => {
          part.text = system[index] ?? part.text
        })
        if (system.length > textParts.length) {
          for (const text of system.slice(textParts.length)) {
            event.system.push({ type: 'text', text })
          }
        }
      },
      { providerID: PROVIDER_ID },
    )
    registrations.defer(() => contextRegistration.dispose())
    const eventAbort = new AbortController()
    const events = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: eventAbort.signal })) {
          const located = event.location?.directory
          const locatedWorkspace = event.location?.workspaceID
          if (located && located !== directory) continue
          if (locatedWorkspace && workspaceID && locatedWorkspace !== workspaceID) continue
          if (
            event.type !== 'session.deleted' &&
            event.type !== 'session.execution.succeeded' &&
            event.type !== 'session.execution.failed' &&
            event.type !== 'session.execution.interrupted'
          ) {
            continue
          }
          const sessionID = event.data.sessionID
          if (!event.location && !ownedSessions.has(sessionID)) continue
          ownedSessions.delete(sessionID)
          routeAffinity().clear(sessionID)
          await clearLiveRoute(sessionID)
        }
      } catch {
        // aborted on plugin unload
      }
    })()
    const activeRegistrations = registrations.move()
    return async () => {
      eventAbort.abort()
      await events.catch(() => undefined)
      await activeRegistrations.disposeAsync()
    }
  },
})
