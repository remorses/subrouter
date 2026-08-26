#!/usr/bin/env node
/**
 * subrouter CLI: manage subscription accounts and model presets.
 *
 * Accounts and presets are stored under ~/.subrouter. The opencode plugin
 * (@subrouter/opencode) reads the same files, so anything configured here is
 * picked up by opencode sessions using the `subrouter/<preset>` models.
 */

import * as clack from '@clack/prompts'
import { colors, goke, isAgent, openInBrowser } from 'goke'
import { createRequire } from 'node:module'
import { z } from 'zod'
import dedent from 'string-dedent'
import { adapters, loadModelsDevCatalog, runLogin, validateModelsDevModelIds } from './adapters/index.ts'
import { builtinDefaultPreset, DEFAULT_PRESET_NAME, resolveCandidates, resolvePresetModels } from './router.ts'
import {
  accountLabel,
  addAccount,
  clearCooldowns,
  cooldownKey,
  isProviderId,
  loadAccounts,
  loadPresets,
  loadState,
  PROVIDER_IDS,
  removeAccount,
  removePreset,
  savePreset,
  type ProviderId,
} from './store.ts'

const require = createRequire(import.meta.url)
const packageJson = require('../package.json') as { version: string }

const cli = goke('subrouter')

function fail(message: string): never {
  console.error(colors.red(message))
  process.exit(1)
}

async function pickProvider(provided: string | undefined): Promise<ProviderId> {
  if (provided) {
    if (!isProviderId(provided)) {
      fail(`Unknown provider ${provided}. Valid providers: ${PROVIDER_IDS.join(', ')}`)
    }
    return provided
  }
  if (isAgent || !process.stdin.isTTY) {
    fail(`Missing provider. Usage: subrouter login <${PROVIDER_IDS.join('|')}>`)
  }
  const choice = await clack.select({
    message: 'Which subscription do you want to add?',
    options: PROVIDER_IDS.map((id) => ({ value: id, label: adapters[id].name })),
  })
  if (clack.isCancel(choice)) process.exit(0)
  return choice
}

async function pickOpenAIMethod(provided: 'browser' | 'device' | undefined) {
  if (provided) return provided
  if (isAgent || !process.stdin.isTTY) return 'browser' as const
  const choice = await clack.select({
    message: 'How do you want to log in to ChatGPT?',
    options: [
      { value: 'browser' as const, label: 'Browser', hint: 'recommended' },
      { value: 'device' as const, label: 'Device code', hint: 'may be disabled for your account' },
    ],
  })
  if (clack.isCancel(choice)) process.exit(0)
  return choice
}

function parsePresetModels(raw: string) {
  const models = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  for (const entry of models) {
    const slash = entry.indexOf('/')
    const provider = entry.slice(0, Math.max(slash, 0))
    if (slash <= 0 || !isProviderId(provider)) {
      fail(
        `Invalid preset entry "${entry}". Use provider/model with provider one of: ${PROVIDER_IDS.join(', ')}`,
      )
    }
  }
  if (models.length === 0) fail('Preset needs at least one provider/model entry')
  return models
}

// --- login / logout ---

cli
  .command(
    'login [provider]',
    dedent`
      Log in to a subscription and add it to the rotation pool.

      Providers: \`anthropic\` (Claude Pro/Max), \`openai\` (ChatGPT via Codex),
      \`xai\` (SuperGrok), \`opencode\` (opencode Go), \`github-copilot\`,
      and \`poe\`.
      Run it again with the same provider to add more accounts.
    `,
  )
  .option(
    '--method [method]',
    z.enum(['browser', 'device']).optional().describe('OpenAI login method'),
  )
  .example('subrouter login anthropic')
  .example('subrouter login openai --method browser')
  .example('subrouter login xai')
  .example('subrouter login github-copilot')
  .example('subrouter login poe')
  .action(async (provider, options) => {
    const id = await pickProvider(provider)
    if (options.method && id !== 'openai') fail('`--method` is only supported for OpenAI login')
    const method = id === 'openai' ? await pickOpenAIMethod(options.method) : undefined
    const adapter = adapters[id]
    const account = await runLogin({
      adapter,
      beginLoginArgs: { method },
      log: (message) => {
        console.error(message)
      },
      openUrl: async (url) => {
        await openInBrowser(url)
      },
      promptManualInput:
        process.stdin.isTTY && !isAgent
          ? async () => {
              const input = await clack.text({
                message: 'Paste the code / redirect URL / API key here (or wait for the browser callback)',
                defaultValue: '',
              })
              if (clack.isCancel(input)) return null
              return input || null
            }
          : undefined,
    })
    if (account instanceof Error) fail(account.message)
    await addAccount({ provider: id, account })
    console.log(colors.green(`Logged in to ${adapter.name} as ${accountLabel(account)}`))
  })

cli
  .command('logout <provider>', 'Remove all stored accounts for a provider')
  .example('subrouter logout anthropic')
  .action(async (provider) => {
    if (!isProviderId(provider)) {
      fail(`Unknown provider ${provider}. Valid providers: ${PROVIDER_IDS.join(', ')}`)
    }
    const accounts = await loadAccounts()
    const pool = accounts.providers[provider]
    const count = pool?.accounts.length ?? 0
    for (let i = count - 1; i >= 0; i--) {
      const removed = await removeAccount({ provider, index: i })
      if (removed instanceof Error) {
        console.error(colors.yellow(removed.message))
      }
    }
    console.log(`Removed ${count} account(s) for ${provider}`)
  })

// --- account ---

cli
  .command('account list', 'List stored accounts across all providers')
  .option('--json', 'Machine readable output')
  .action(async (options) => {
    const accounts = await loadAccounts()
    const state = await loadState()
    if (options.json) {
      const output = Object.fromEntries(
        PROVIDER_IDS.flatMap((provider) => {
          const pool = accounts.providers[provider]
          if (!pool) return []
          return [
            [
              provider,
              {
                activeIndex: pool.activeIndex,
                accounts: pool.accounts.map((account, index) => ({
                  index,
                  label: accountLabel(account),
                  type: account.type,
                  email: account.email,
                  accountId: account.accountId,
                  coolingDownUntil: state.cooldowns[cooldownKey({ provider, account })] ?? null,
                })),
              },
            ],
          ]
        }),
      )
      console.log(JSON.stringify(output, null, 2))
      return
    }
    for (const id of PROVIDER_IDS) {
      const pool = accounts.providers[id]
      console.log(colors.bold(adapters[id].name))
      if (!pool || pool.accounts.length === 0) {
        console.log(colors.dim(`  no accounts. run: subrouter login ${id}`))
        continue
      }
      pool.accounts.forEach((account, index) => {
        const active = index === pool.activeIndex ? '*' : ' '
        const until = state.cooldowns[cooldownKey({ provider: id, account })]
        const cooldown = until
          ? colors.yellow(` (cooling down until ${new Date(until).toLocaleTimeString()})`)
          : ''
        console.log(`  ${active} ${accountLabel(account, index)}${cooldown}`)
      })
    }
  })

cli
  .command('account remove <provider> <indexOrEmail>', 'Remove one account from a provider pool')
  .example('subrouter account remove anthropic 2')
  .example('subrouter account remove openai me@example.com')
  .action(async (provider, indexOrEmail) => {
    if (!isProviderId(provider)) {
      fail(`Unknown provider ${provider}. Valid providers: ${PROVIDER_IDS.join(', ')}`)
    }
    const accounts = await loadAccounts()
    const pool = accounts.providers[provider]
    const index = (() => {
      const asNumber = Number(indexOrEmail)
      if (Number.isInteger(asNumber) && asNumber >= 1) return asNumber - 1
      const found = pool?.accounts.findIndex(
        (account) => account.email?.toLowerCase() === indexOrEmail.toLowerCase(),
      )
      return found ?? -1
    })()
    const removed = await removeAccount({ provider, index })
    if (removed instanceof Error) fail(removed.message)
    console.log(`Removed ${provider} account ${accountLabel(removed)}`)
  })

// --- preset ---

cli
  .command(
    'preset create <name>',
    dedent`
      Create (or overwrite) a preset: an ordered list of \`provider/model\`
      entries that subrouter falls through when subscriptions hit limits.
      Model IDs are validated against models.dev before saving.
      Use the preset in opencode as model \`subrouter/<name>\`.
    `,
  )
  .option('--models [models]', z.string().optional().describe('Comma-separated provider/model entries, ranked'))
  .example("subrouter preset create work --models 'anthropic/claude-opus-4-6,openai/gpt-5.5,xai/grok-4.6'")
  .action(async (name, options) => {
    const raw = await (async () => {
      if (options.models) return options.models
      if (isAgent || !process.stdin.isTTY) {
        fail("Missing --models. Usage: subrouter preset create work --models 'anthropic/claude-opus-4-6,xai/grok-4.6'")
      }
      const input = await clack.text({
        message: 'Ranked provider/model entries, comma separated',
        placeholder: 'anthropic/claude-opus-4-6,openai/gpt-5.5,xai/grok-4.6',
      })
      if (clack.isCancel(input) || !input) process.exit(0)
      return input
    })()
    const models = parsePresetModels(raw)
    const catalog = await loadModelsDevCatalog()
    if (catalog instanceof Error) fail(catalog.message)
    const invalidModel = validateModelsDevModelIds({ entries: models, catalog })
    if (invalidModel instanceof Error) fail(invalidModel.message)
    await savePreset({ name, models })
    console.log(colors.green(`Preset ${name} saved:`))
    models.forEach((entry, index) => {
      console.log(`  ${index + 1}. ${entry}`)
    })
    console.log(`Use it in opencode as model: subrouter/${name}`)
  })

cli.command('preset list', 'List presets, including the builtin default').action(async () => {
  const presets = await loadPresets()
  const names = new Set([DEFAULT_PRESET_NAME, ...Object.keys(presets.presets)])
  for (const name of names) {
    const models = await resolvePresetModels(name)
    if (models instanceof Error) continue
    const builtin = name === DEFAULT_PRESET_NAME && !presets.presets[name] ? colors.dim(' (builtin)') : ''
    console.log(`${colors.bold(name)}${builtin}`)
    models.forEach((entry, index) => {
      console.log(`  ${index + 1}. ${entry}`)
    })
  }
})

cli
  .command('preset show <name>', 'Show one preset and its current usable candidates')
  .action(async (name) => {
    const models = await resolvePresetModels(name)
    if (models instanceof Error) fail(models.message)
    console.log(colors.bold(name))
    models.forEach((entry, index) => {
      console.log(`  ${index + 1}. ${entry}`)
    })
    const { candidates, skipped } = await resolveCandidates({ presetModels: models })
    console.log(colors.bold('\nUsable candidates now:'))
    if (candidates.length === 0) console.log(colors.yellow('  none'))
    candidates.forEach((candidate) => {
      console.log(`  ${candidate.provider}/${candidate.modelId} ${accountLabel(candidate.account, candidate.accountIndex)}`)
    })
    for (const reason of skipped) {
      console.log(colors.dim(`  skipped ${reason}`))
    }
  })

cli
  .command('preset remove <name>', 'Delete a preset')
  .action(async (name) => {
    const result = await removePreset(name)
    if (result instanceof Error) fail(result.message)
    console.log(`Removed preset ${name}`)
  })

// --- status / cooldowns ---

cli.command('status', 'Show accounts, cooldowns and presets at a glance').action(async () => {
  const accounts = await loadAccounts()
  const state = await loadState()
  const presets = await loadPresets()
  for (const id of PROVIDER_IDS) {
    const pool = accounts.providers[id]
    const count = pool?.accounts.length ?? 0
    const cooling = (pool?.accounts ?? []).filter(
      (account) => state.cooldowns[cooldownKey({ provider: id, account })],
    ).length
    const suffix = cooling > 0 ? colors.yellow(` (${cooling} cooling down)`) : ''
    console.log(`${adapters[id].name}: ${count} account(s)${suffix}`)
  }
  const presetNames = [DEFAULT_PRESET_NAME, ...Object.keys(presets.presets).filter((n) => n !== DEFAULT_PRESET_NAME)]
  console.log(`Presets: ${presetNames.join(', ')}`)
  console.log(colors.dim('Default preset ranking:'))
  const models = presets.presets[DEFAULT_PRESET_NAME] ?? builtinDefaultPreset()
  models.forEach((entry, index) => {
    console.log(colors.dim(`  ${index + 1}. ${entry}`))
  })
})

cli
  .command('cooldown clear', 'Clear all rate-limit cooldowns so every account is retried')
  .action(async () => {
    await clearCooldowns()
    console.log('Cleared all cooldowns')
  })

cli.help()
cli.completions()
cli.version(packageJson.version)
cli.parse(process.argv).catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  process.stderr.write(message + '\n')
  process.exit(1)
})
