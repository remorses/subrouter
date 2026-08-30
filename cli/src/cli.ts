/**
 * Defines the subrouter CLI for the binary and runtime tests.
 *
 * Accounts and presets are stored under ~/.subrouter. The opencode plugin
 * (@subrouter/opencode) reads the same files, so anything configured here is
 * picked up by opencode sessions using the `subrouter/<preset>` models.
 */

import * as clack from '@clack/prompts'
import { colors, goke, isAgent, openInBrowser, type GokeExecutionContext } from 'goke'
import { createRequire } from 'node:module'
import { z } from 'zod'
import dedent from 'string-dedent'
import {
  adapters,
  loadModelsDevCatalog,
  runLogin,
  setSubrouterLog,
  validateModelsDevModelIds,
} from './adapters/index.ts'
import { builtinDefaultPreset, DEFAULT_PRESET_NAME, resolveCandidates, resolvePresetModels } from './router.ts'
import {
  accountLabel,
  addAccount,
  clearCooldowns,
  clearLoginState,
  cooldownKey,
  isProviderId,
  loadAccounts,
  loadLoginState,
  loadPresets,
  loadState,
  orderAccounts,
  PROVIDER_IDS,
  removeAccount,
  removePreset,
  saveLoginState,
  savePreset,
  type LoginState,
  type ProviderId,
} from './store.ts'

const require = createRequire(import.meta.url)
const packageJson = require('../package.json') as { version: string }

export const cli = goke('subrouter')

cli.use((_options, ctx) => {
  setSubrouterLog((entry) => {
    if (entry.level === 'error') ctx.console.error(entry.message)
    else if (entry.level === 'warn') ctx.console.warn(entry.message)
    else ctx.console.log(entry.message)
  })
})

const CODE_LOGIN_PROVIDERS = new Set<ProviderId>(['opencode-go', 'minimax', 'kimi', 'zai', 'alibaba'])

function shouldOpenLoginBrowser(id: ProviderId) {
  return !CODE_LOGIN_PROVIDERS.has(id)
}
// Must outlive the adapter OAuth wait (30 min) or the daemon kills the callback
// server before the browser redirect can arrive.
const LOGIN_TIMEOUT_MS = 35 * 60 * 1000

function loginDaemonName(provider: ProviderId) {
  return `login ${provider}`
}

function exit(ctx: GokeExecutionContext, code: number): never {
  ctx.process.exit(code)
  throw new Error(`Process did not exit with code ${code}`)
}

function fail(ctx: GokeExecutionContext, message: string): never {
  ctx.console.error(colors.red(message))
  exit(ctx, 1)
}

async function pickProvider({
  provided,
  ctx,
  missing = `Missing provider. Usage: subrouter login <${PROVIDER_IDS.join('|')}>`,
  prompt = 'Which subscription do you want to add?',
}: {
  provided: string | undefined
  ctx: GokeExecutionContext
  missing?: string
  prompt?: string
}): Promise<ProviderId> {
  if (provided) {
    if (!isProviderId(provided)) {
      fail(ctx, `Unknown provider ${provided}. Valid providers: ${PROVIDER_IDS.join(', ')}`)
    }
    return provided
  }
  if (isAgent || !process.stdin.isTTY) fail(ctx, missing)
  const choice = await clack.select({
    message: prompt,
    options: PROVIDER_IDS.map((id) => ({ value: id, label: adapters[id].name })),
  })
  if (clack.isCancel(choice)) exit(ctx, 0)
  return choice
}

async function pickOpenAIMethod(
  provided: 'browser' | 'device' | undefined,
  ctx: GokeExecutionContext,
) {
  if (provided) return provided
  if (isAgent || !process.stdin.isTTY) return 'browser' as const
  const choice = await clack.select({
    message: 'How do you want to log in to ChatGPT?',
    options: [
      { value: 'browser' as const, label: 'Browser', hint: 'recommended' },
      { value: 'device' as const, label: 'Device code', hint: 'may be disabled for your account' },
    ],
  })
  if (clack.isCancel(choice)) exit(ctx, 0)
  return choice
}

async function pickPresetName({
  provided,
  ctx,
  missing,
  prompt,
}: {
  provided: string | undefined
  ctx: GokeExecutionContext
  missing: string
  prompt: string
}) {
  if (provided) return provided
  if (isAgent || !process.stdin.isTTY) fail(ctx, missing)
  const presets = await loadPresets()
  const names = [
    DEFAULT_PRESET_NAME,
    ...Object.keys(presets.presets).filter((name) => name !== DEFAULT_PRESET_NAME),
  ]
  const choice = await clack.select({
    message: prompt,
    options: names.map((name) => ({
      value: name,
      label: name,
      hint: name === DEFAULT_PRESET_NAME && !presets.presets[name] ? 'builtin' : undefined,
    })),
  })
  if (clack.isCancel(choice)) exit(ctx, 0)
  return choice
}

function parsePresetModels(raw: string, ctx: GokeExecutionContext) {
  const models = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  for (const entry of models) {
    const slash = entry.indexOf('/')
    const provider = entry.slice(0, Math.max(slash, 0))
    if (slash <= 0 || !isProviderId(provider)) {
      fail(
        ctx,
        `Invalid preset entry "${entry}". Use provider/model with provider one of: ${PROVIDER_IDS.join(', ')}`,
      )
    }
  }
  if (models.length === 0) fail(ctx, 'Preset needs at least one provider/model entry')
  return models
}

async function confirmDestructive({
  force,
  message,
  nonInteractiveMessage,
  ctx,
}: {
  force: boolean
  message: string
  nonInteractiveMessage: string
  ctx: GokeExecutionContext
}) {
  if (force) return
  if (isAgent || !process.stdin.isTTY) fail(ctx, nonInteractiveMessage)
  const confirmed = await clack.confirm({ message, initialValue: false })
  if (clack.isCancel(confirmed) || !confirmed) exit(ctx, 0)
}

async function waitForLoginState(provider: ProviderId, ctx: GokeExecutionContext) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const state = await loadLoginState(provider)
    if (state) return state
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  fail(ctx, 'Login did not start. Run the command again.')
}

async function completeLogin({
  id,
  method,
  input,
  background,
  ctx,
}: {
  id: ProviderId
  method?: 'browser' | 'device'
  input?: string
  background: boolean
  ctx: GokeExecutionContext
}) {
  return runLogin({
    adapter: adapters[id],
    beginLoginArgs: { method, manualInput: Boolean(input) || undefined },
    log: (message) => {
      if (!background) ctx.console.error(message)
    },
    openUrl: async (url, session) => {
      if (background) {
        await saveLoginState({
          provider: id,
          status: 'pending',
          instructions: session.instructions,
          url,
        })
        return
      }
      if (shouldOpenLoginBrowser(id) && process.stdin.isTTY) await openInBrowser(url)
    },
    promptManualInput: input
      ? async () => input
      : process.stdin.isTTY && !isAgent
        ? async () => {
            const value = await clack.text({
              message: 'Paste the code / redirect URL / API key here (or wait for the browser callback)',
              defaultValue: '',
            })
            if (clack.isCancel(value)) return null
            return value || null
          }
        : undefined,
  })
}

// --- login / logout ---

/** Providers whose browser redirect lands on a localhost callback server. */
const CALLBACK_LOGIN_PROVIDERS = new Set<ProviderId>(['anthropic', 'openai', 'poe'])

function loginDescription(id: ProviderId) {
  const first = `Log in to ${adapters[id].name}. Run it again to add another account to the rotation pool.`
  if (!CALLBACK_LOGIN_PROVIDERS.has(id)) return first
  return dedent`
    ${first}

    The browser redirect lands on a localhost callback server owned by this login
    process, and the command prints that callback URL next to the authorize URL.
    If the browser cannot deliver the redirect, replay it by hand while the login
    is still running: \`curl '<callback-url>?code=...&state=...'\`. Run curl on the
    login machine and never paste the redirect URL into a shared chat. Once the
    login exits, the callback server closes and curl replay stops working.
  `
}

const loginMethodOption = [
  '--method [method]',
  z.enum(['browser', 'device']).optional().describe('OpenAI login method: browser or device'),
] as const
const loginInputOption = [
  '--input [input]',
  z.string().optional().describe('Redirect URL or subscription key for non-interactive login'),
] as const

async function runProviderLogin({
  id,
  options,
  ctx,
}: {
  id: ProviderId
  options: { method?: 'browser' | 'device'; input?: string }
  ctx: GokeExecutionContext
}) {
  const requestedMethod = options.method
  if (requestedMethod && id !== 'openai') {
    fail(ctx, '`--method` is only supported for OpenAI login')
  }
  const method = id === 'openai' ? await pickOpenAIMethod(requestedMethod, ctx) : undefined
  const input = options.input || undefined
  if (
    input &&
    (id === 'xai' || id === 'github-copilot' || (id === 'openai' && method === 'device'))
  ) {
    fail(ctx, `\`--input\` is not supported for ${id} device login`)
  }

  if (ctx.daemon.isDaemon) {
    const account = await completeLogin({ id, method, background: true, ctx })
    if (account instanceof Error) {
      await saveLoginState({ provider: id, status: 'error', error: account.message })
      fail(ctx, account.message)
    }
    await addAccount({ provider: id, account })
    return
  }

  const manualOAuth =
    (id === 'anthropic' || id === 'poe' || (id === 'openai' && method === 'browser')) &&
    Boolean(ctx.process.env.SUBROUTER_MANUAL_OAUTH)
  const requiresInput = CODE_LOGIN_PROVIDERS.has(id) || manualOAuth
  if ((isAgent || !process.stdin.isTTY) && requiresInput && !input) {
    fail(ctx, `Missing --input. Usage: subrouter login ${id} --input <value>`)
  }

  if ((isAgent || !process.stdin.isTTY) && !input) {
    await clearLoginState(id)
    await ctx.daemon.forCommand(loginDaemonName(id)).start({ timeoutMs: LOGIN_TIMEOUT_MS })
    const state = await waitForLoginState(id, ctx)
    if (state.status === 'error') fail(ctx, state.error ?? 'Login failed')
    if (state.instructions) ctx.console.error(state.instructions)
    // Instructions then URL, the same order `account status` uses. Printing
    // the URL here is the whole point of a background login: the person
    // reading a chat window has no other way to reach it.
    if (state.url) {
      ctx.console.error(state.url)
      if (shouldOpenLoginBrowser(id) && process.stdin.isTTY) await openInBrowser(state.url)
    }
    ctx.console.log(
      `Login running in background. After approving, verify with: subrouter account status ${id}`,
    )
    return
  }

  const account = await completeLogin({ id, method, input, background: false, ctx })
  if (account instanceof Error) fail(ctx, account.message)
  await addAccount({ provider: id, account })
  ctx.console.log(colors.green(`Logged in to ${adapters[id].name} as ${accountLabel(account)}`))
}

cli
  .command('login [provider]', 'Log in to a subscription. Omit the provider to pick one interactively.')
  .example('subrouter login')
  .example('subrouter login anthropic')
  .option(...loginMethodOption)
  .option(...loginInputOption)
  .action(async (provider, options, ctx) => {
    const id = await pickProvider({ provided: provider, ctx })
    await runProviderLogin({ id, options, ctx })
  })

for (const id of PROVIDER_IDS) {
  cli
    .command(`login ${id}`, loginDescription(id))
    .example(`subrouter login ${id}`)
    .option(...loginMethodOption)
    .option(...loginInputOption)
    .action(async (options, ctx) => {
      await runProviderLogin({ id, options, ctx })
    })
}

cli
  .command('logout [provider]', 'Remove all stored accounts for a provider')
  .option('--force', 'Skip confirmation')
  .example('subrouter logout anthropic')
  .action(async (provider, options, ctx) => {
    const id = await pickProvider({
      provided: provider,
      ctx,
      missing: `Missing provider. Usage: subrouter logout <${PROVIDER_IDS.join('|')}>`,
      prompt: 'Which subscription do you want to remove?',
    })
    const accounts = await loadAccounts()
    const pool = accounts.providers[id]
    const count = pool?.accounts.length ?? 0
    if (count > 0) {
      await confirmDestructive({
        force: Boolean(options.force),
        message: `Remove all ${count} account(s) for ${id}?`,
        nonInteractiveMessage: 'Use --force to remove all accounts non-interactively',
        ctx,
      })
    }
    await ctx.daemon.forCommand(loginDaemonName(id)).stop()
    await clearLoginState(id)
    for (let i = count - 1; i >= 0; i--) {
      const removed = await removeAccount({ provider: id, index: i })
      if (removed instanceof Error) {
        ctx.console.error(colors.yellow(removed.message))
      }
    }
    ctx.console.log(`Removed ${count} account(s) for ${id}`)
  })

// --- account ---

cli
  .command('account list', 'List stored accounts across all providers')
  .option('--json', 'Machine readable output')
  .action(async (options, ctx) => {
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
      ctx.console.log(JSON.stringify(output, null, 2))
      return
    }
    for (const id of PROVIDER_IDS) {
      const pool = accounts.providers[id]
      ctx.console.log(colors.bold(adapters[id].name))
      if (!pool || pool.accounts.length === 0) {
        ctx.console.log(colors.dim(`  no accounts. run: subrouter login ${id}`))
        continue
      }
      pool.accounts.forEach((account, index) => {
        const active = index === pool.activeIndex ? '*' : ' '
        const until = state.cooldowns[cooldownKey({ provider: id, account })]
        const cooldown = until
          ? colors.yellow(` (cooling down until ${new Date(until).toLocaleTimeString()})`)
          : ''
        ctx.console.log(`  ${active} ${accountLabel(account, index)}${cooldown}`)
      })
    }
  })

cli
  .command('account status [provider]', 'Check provider login status (exits 1 if not logged in)')
  .example('subrouter account status anthropic')
  .action(async (provider, _options, ctx) => {
    const id = await pickProvider({ provided: provider, ctx })
    // The login state is checked before the stored accounts on purpose. Counting
    // accounts first reported success for a login that never finished, because
    // the expired account the user was replacing was still on disk. Every login
    // path clears this entry once it stores an account.
    const state = await loadLoginState(id)
    if (state?.provider === id && state.status === 'pending') {
      if (await ctx.daemon.forCommand(loginDaemonName(id)).isRunning()) {
        ctx.console.error(`Login to ${id} is in progress.`)
        if (state.instructions) ctx.console.error(state.instructions)
        if (state.url) ctx.console.error(state.url)
        exit(ctx, 1)
      }
      await clearLoginState(id)
      ctx.console.error(colors.yellow(`Login to ${id} stopped before it finished.`))
    }
    if (state?.provider === id && state.status === 'error') {
      fail(ctx, state.error ?? `Login to ${id} failed`)
    }

    const count = (await loadAccounts()).providers[id]?.accounts.length ?? 0
    if (count > 0) {
      ctx.console.log(`Logged in to ${id} with ${count} account(s).`)
      return
    }
    fail(ctx, `Not logged in to ${id}. Run \`subrouter login ${id}\`.`)
  })

cli
  .command('account remove [provider] [indexOrEmail]', 'Remove one account from a provider pool')
  .option('--force', 'Skip confirmation')
  .example('subrouter account remove anthropic 2')
  .example('subrouter account remove openai me@example.com')
  .action(async (provider, indexOrEmail, options, ctx) => {
    const id = await pickProvider({
      provided: provider,
      ctx,
      missing: `Missing provider. Usage: subrouter account remove <${PROVIDER_IDS.join('|')}> <n|email>`,
      prompt: 'Which provider account do you want to remove?',
    })
    const accounts = await loadAccounts()
    const pool = accounts.providers[id]
    const index = await (async () => {
      if (indexOrEmail) {
        const asNumber = Number(indexOrEmail)
        if (Number.isInteger(asNumber) && asNumber >= 1) return asNumber - 1
        return (
          pool?.accounts.findIndex(
            (account) => account.email?.toLowerCase() === indexOrEmail.toLowerCase(),
          ) ?? -1
        )
      }
      if (isAgent || !process.stdin.isTTY) {
        fail(ctx, `Missing account. Usage: subrouter account remove ${id} <n|email>`)
      }
      if (!pool || pool.accounts.length === 0) fail(ctx, `No accounts for ${id}`)
      const choice = await clack.select({
        message: `Which ${id} account do you want to remove?`,
        options: pool.accounts.map((account, accountIndex) => ({
          value: accountIndex,
          label: accountLabel(account, accountIndex),
        })),
      })
      if (clack.isCancel(choice)) exit(ctx, 0)
      return choice
    })()
    const target = pool?.accounts[index]
    if (!target) fail(ctx, `Account ${indexOrEmail ?? index} does not exist for ${id}`)
    await confirmDestructive({
      force: Boolean(options.force),
      message: `Remove ${id} account ${accountLabel(target)}?`,
      nonInteractiveMessage: 'Use --force to remove an account non-interactively',
      ctx,
    })
    const removed = await removeAccount({ provider: id, index })
    if (removed instanceof Error) fail(ctx, removed.message)
    ctx.console.log(`Removed ${id} account ${accountLabel(removed)}`)
  })

cli
  .command(
    'account order [...emails]',
    dedent`
      Set the rotation order for one provider. Pass every account email.

      The first email is tried first. Later emails are fallbacks when that
      account hits a rate or usage limit.
    `,
  )
  .option(
    '--provider [provider]',
    z.enum(PROVIDER_IDS).optional().describe('Provider whose accounts to reorder'),
  )
  .example('subrouter account order --provider anthropic work@x.com personal@x.com')
  .action(async (emails, options, ctx) => {
    const provider = await pickProvider({
      provided: options.provider,
      ctx,
      missing: `Missing --provider. Usage: subrouter account order --provider <${PROVIDER_IDS.join('|')}> <email> <email>`,
      prompt: 'Which provider accounts do you want to reorder?',
    })
    const accounts = await loadAccounts()
    const pool = accounts.providers[provider]
    if (!pool || pool.accounts.length === 0) {
      fail(ctx, `No accounts for ${provider}. Run: subrouter login ${provider}`)
    }
    const currentEmails = pool.accounts.map((account) => account.email?.trim()).filter(Boolean)
    if (currentEmails.length !== pool.accounts.length) {
      fail(ctx, `Every ${provider} account needs an email before it can be ordered`)
    }
    const listed = await (async () => {
      const fromArgs = emails.flatMap((entry) => entry.split(',')).map((entry) => entry.trim()).filter(Boolean)
      if (fromArgs.length > 0) return fromArgs
      if (isAgent || !process.stdin.isTTY) {
        fail(
          ctx,
          `Missing emails. Usage: subrouter account order --provider ${provider} ${currentEmails.join(' ')}`,
        )
      }
      const input = await clack.text({
        message: `Rank every ${provider} email, comma separated`,
        placeholder: currentEmails.join(', '),
      })
      if (clack.isCancel(input) || !input) exit(ctx, 0)
      return input.split(',').map((entry) => entry.trim()).filter(Boolean)
    })()
    const ordered = await orderAccounts({ provider, emails: listed })
    if (ordered instanceof Error) fail(ctx, ordered.message)
    ctx.console.log(colors.green(`${adapters[provider].name} account order:`))
    ordered.forEach((account, index) => {
      ctx.console.log(`  ${index + 1}. ${accountLabel(account, index)}`)
    })
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
  .option('--force', 'Overwrite an existing preset without confirmation')
  .example("subrouter preset create work --models 'anthropic/claude-opus-4-6,openai/gpt-5.5,xai/grok-4.6'")
  .action(async (name, options, ctx) => {
    const raw = await (async () => {
      if (options.models) return options.models
      if (isAgent || !process.stdin.isTTY) {
        fail(ctx, "Missing --models. Usage: subrouter preset create work --models 'anthropic/claude-opus-4-6,xai/grok-4.6'")
      }
      const input = await clack.text({
        message: 'Ranked provider/model entries, comma separated',
        placeholder: 'anthropic/claude-opus-4-6,openai/gpt-5.5,xai/grok-4.6',
      })
      if (clack.isCancel(input) || !input) exit(ctx, 0)
      return input
    })()
    const models = parsePresetModels(raw, ctx)
    if ((await loadPresets()).presets[name]) {
      await confirmDestructive({
        force: Boolean(options.force),
        message: `Overwrite preset ${name}?`,
        nonInteractiveMessage: 'Use --force to overwrite a preset non-interactively',
        ctx,
      })
    }
    const catalog = await loadModelsDevCatalog()
    if (catalog instanceof Error) fail(ctx, catalog.message)
    const invalidModel = validateModelsDevModelIds({ entries: models, catalog })
    if (invalidModel instanceof Error) fail(ctx, invalidModel.message)
    await savePreset({ name, models })
    ctx.console.log(colors.green(`Preset ${name} saved:`))
    models.forEach((entry, index) => {
      ctx.console.log(`  ${index + 1}. ${entry}`)
    })
    ctx.console.log(`Use it in opencode as model: subrouter/${name}`)
  })

cli.command('preset list', 'List presets, including the builtin default').action(async (_options, ctx) => {
  const presets = await loadPresets()
  const names = new Set([DEFAULT_PRESET_NAME, ...Object.keys(presets.presets)])
  for (const name of names) {
    const models = await resolvePresetModels(name)
    if (models instanceof Error) continue
    const builtin = name === DEFAULT_PRESET_NAME && !presets.presets[name] ? colors.dim(' (builtin)') : ''
    ctx.console.log(`${colors.bold(name)}${builtin}`)
    models.forEach((entry, index) => {
      ctx.console.log(`  ${index + 1}. ${entry}`)
    })
  }
})

cli
  .command('preset show [name]', 'Show one preset and its current usable candidates')
  .example('subrouter preset show work')
  .action(async (name, _options, ctx) => {
    name = await pickPresetName({
      provided: name,
      ctx,
      missing: 'Missing name. Usage: subrouter preset show <name>',
      prompt: 'Which preset do you want to show?',
    })
    const models = await resolvePresetModels(name)
    if (models instanceof Error) fail(ctx, models.message)
    ctx.console.log(colors.bold(name))
    models.forEach((entry, index) => {
      ctx.console.log(`  ${index + 1}. ${entry}`)
    })
    const { candidates, skipped } = await resolveCandidates({ presetModels: models })
    ctx.console.log(colors.bold('\nUsable candidates now:'))
    if (candidates.length === 0) ctx.console.log(colors.yellow('  none'))
    candidates.forEach((candidate) => {
      ctx.console.log(`  ${candidate.provider}/${candidate.modelId} ${accountLabel(candidate.account, candidate.accountIndex)}`)
    })
    for (const reason of skipped) {
      ctx.console.log(colors.dim(`  skipped ${reason}`))
    }
  })

cli
  .command('preset remove [name]', 'Delete a preset')
  .option('--force', 'Skip confirmation')
  .example('subrouter preset remove work')
  .action(async (name, options, ctx) => {
    name = await pickPresetName({
      provided: name,
      ctx,
      missing: 'Missing name. Usage: subrouter preset remove <name>',
      prompt: 'Which preset do you want to remove?',
    })
    if (!(await loadPresets()).presets[name]) fail(ctx, `Preset ${name} does not exist`)
    await confirmDestructive({
      force: Boolean(options.force),
      message: `Remove preset ${name}?`,
      nonInteractiveMessage: 'Use --force to remove a preset non-interactively',
      ctx,
    })
    const result = await removePreset(name)
    if (result instanceof Error) fail(ctx, result.message)
    ctx.console.log(`Removed preset ${name}`)
  })

// --- status / cooldowns ---

cli.command('status', 'Show accounts, cooldowns and presets at a glance').action(async (_options, ctx) => {
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
    ctx.console.log(`${adapters[id].name}: ${count} account(s)${suffix}`)
  }
  const presetNames = [DEFAULT_PRESET_NAME, ...Object.keys(presets.presets).filter((n) => n !== DEFAULT_PRESET_NAME)]
  ctx.console.log(`Presets: ${presetNames.join(', ')}`)
  ctx.console.log(colors.dim('Default preset ranking:'))
  const models = presets.presets[DEFAULT_PRESET_NAME] ?? builtinDefaultPreset()
  models.forEach((entry, index) => {
    ctx.console.log(colors.dim(`  ${index + 1}. ${entry}`))
  })
})

cli
  .command('cooldown clear', 'Clear all rate-limit cooldowns so every account is retried')
  .option('--force', 'Skip confirmation')
  .action(async (options, ctx) => {
    if (Object.keys((await loadState()).cooldowns).length > 0) {
      await confirmDestructive({
        force: Boolean(options.force),
        message: 'Clear all rate-limit cooldowns?',
        nonInteractiveMessage: 'Use --force to clear cooldowns non-interactively',
        ctx,
      })
    }
    await clearCooldowns()
    ctx.console.log('Cleared all cooldowns')
  })

cli.help()
cli.completions()
cli.version(packageJson.version)
