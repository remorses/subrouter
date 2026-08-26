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
import path from 'node:path'
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
  readJson,
  removeAccount,
  removePreset,
  savePreset,
  subrouterHome,
  type ProviderId,
  writeJson,
} from './store.ts'

const require = createRequire(import.meta.url)
const packageJson = require('../package.json') as { version: string }

export const cli = goke('subrouter')

type LoginState = {
  provider: ProviderId
  status: 'pending' | 'error'
  instructions?: string
  url?: string
  error?: string
}

const CODE_LOGIN_PROVIDERS = new Set<ProviderId>(['opencode', 'minimax', 'kimi', 'zai', 'alibaba'])
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000

function loginStatePath() {
  return path.join(subrouterHome(), 'login.json')
}

function exit(ctx: GokeExecutionContext, code: number): never {
  ctx.process.exit(code)
  throw new Error(`Process did not exit with code ${code}`)
}

function fail(ctx: GokeExecutionContext, message: string): never {
  ctx.console.error(colors.red(message))
  exit(ctx, 1)
}

async function pickProvider(
  provided: string | undefined,
  ctx: GokeExecutionContext,
): Promise<ProviderId> {
  if (provided) {
    if (!isProviderId(provided)) {
      fail(ctx, `Unknown provider ${provided}. Valid providers: ${PROVIDER_IDS.join(', ')}`)
    }
    return provided
  }
  if (isAgent || !process.stdin.isTTY) {
    fail(ctx, `Missing provider. Usage: subrouter login <${PROVIDER_IDS.join('|')}>`)
  }
  const choice = await clack.select({
    message: 'Which subscription do you want to add?',
    options: PROVIDER_IDS.map((id) => ({ value: id, label: adapters[id].name })),
  })
  if (typeof choice === 'symbol') exit(ctx, 0)
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
  if (typeof choice === 'symbol') exit(ctx, 0)
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

async function writeLoginState(state: LoginState) {
  await writeJson(loginStatePath(), state)
}

async function waitForLoginState(ctx: GokeExecutionContext) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const state = await readJson<LoginState | null>(loginStatePath(), null)
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
  const messages: string[] = []
  return runLogin({
    adapter: adapters[id],
    beginLoginArgs: { method, manualInput: Boolean(input) || undefined },
    log: (message) => {
      messages.push(message)
      if (!background) ctx.console.error(message)
    },
    openUrl: async (url) => {
      if (background) {
        await writeLoginState({
          provider: id,
          status: 'pending',
          instructions: messages.join('\n'),
          url,
        })
        return
      }
      if (process.stdin.isTTY) await openInBrowser(url)
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

cli
  .command(
    'login [provider]',
    dedent`
      Log in to a subscription and add it to the rotation pool.

      Providers: \`anthropic\` (Claude Pro/Max), \`openai\` (ChatGPT via Codex),
      \`xai\` (SuperGrok), \`opencode\` (opencode Go), \`github-copilot\`,
      \`poe\`, \`minimax\`, \`kimi\`, \`zai\`, and \`alibaba\`.
      Run it again with the same provider to add more accounts.
    `,
  )
  .option(
    '--method [method]',
    z.enum(['browser', 'device']).optional().describe('OpenAI login method'),
  )
  .option(
    '--input [input]',
    z.string().optional().describe('Pasted redirect URL or subscription key'),
  )
  .example('subrouter login anthropic')
  .example('subrouter login openai --method browser')
  .example('subrouter login xai')
  .example('subrouter login github-copilot')
  .example('subrouter login poe')
  .example('subrouter login minimax')
  .example('subrouter login kimi')
  .action(async (provider, options, ctx) => {
    const id = await pickProvider(provider, ctx)
    if (options.method && id !== 'openai') {
      fail(ctx, '`--method` is only supported for OpenAI login')
    }
    const requestedMethod =
      typeof options.method === 'string' && options.method ? options.method : undefined
    const method = id === 'openai' ? await pickOpenAIMethod(requestedMethod, ctx) : undefined
    const adapter = adapters[id]
    const input = typeof options.input === 'string' && options.input ? options.input : undefined
    if (
      input &&
      (id === 'xai' || id === 'github-copilot' || (id === 'openai' && method === 'device'))
    ) {
      fail(ctx, `\`--input\` is not supported for ${id} device login`)
    }

    if (ctx.daemon.isDaemon) {
      const account = await completeLogin({ id, method, background: true, ctx })
      if (account instanceof Error) {
        await writeLoginState({ provider: id, status: 'error', error: account.message })
        fail(ctx, account.message)
      }
      await addAccount({ provider: id, account })
      await ctx.fs.rm(loginStatePath(), { force: true })
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
      await ctx.fs.rm(loginStatePath(), { force: true })
      await ctx.daemon.start({ timeoutMs: LOGIN_TIMEOUT_MS })
      const state = await waitForLoginState(ctx)
      if (state.status === 'error') fail(ctx, state.error ?? 'Login failed')
      if (state.instructions) ctx.console.error(state.instructions)
      if (state.url && process.stdin.isTTY) await openInBrowser(state.url)
      ctx.console.log(
        `Login running in background. After approving, verify with: subrouter account status ${id}`,
      )
      return
    }

    const account = await completeLogin({
      id,
      method,
      input,
      background: false,
      ctx,
    })
    if (account instanceof Error) fail(ctx, account.message)
    await addAccount({ provider: id, account })
    ctx.console.log(colors.green(`Logged in to ${adapter.name} as ${accountLabel(account)}`))
  })

cli
  .command('logout <provider>', 'Remove all stored accounts for a provider')
  .option('--force', 'Skip confirmation')
  .example('subrouter logout anthropic')
  .action(async (provider, options, ctx) => {
    if (!isProviderId(provider)) {
      fail(ctx, `Unknown provider ${provider}. Valid providers: ${PROVIDER_IDS.join(', ')}`)
    }
    const accounts = await loadAccounts()
    const pool = accounts.providers[provider]
    const count = pool?.accounts.length ?? 0
    if (count > 0) {
      await confirmDestructive({
        force: Boolean(options.force),
        message: `Remove all ${count} account(s) for ${provider}?`,
        nonInteractiveMessage: 'Use --force to remove all accounts non-interactively',
        ctx,
      })
    }
    const loginState = await readJson<LoginState | null>(loginStatePath(), null)
    if (loginState?.provider === provider) {
      await ctx.daemon.forCommand('login').stop()
      await ctx.fs.rm(loginStatePath(), { force: true })
    }
    for (let i = count - 1; i >= 0; i--) {
      const removed = await removeAccount({ provider, index: i })
      if (removed instanceof Error) {
        ctx.console.error(colors.yellow(removed.message))
      }
    }
    ctx.console.log(`Removed ${count} account(s) for ${provider}`)
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
    const id = await pickProvider(provider, ctx)
    const count = (await loadAccounts()).providers[id]?.accounts.length ?? 0
    if (count > 0) {
      ctx.console.log(`Logged in to ${id} with ${count} account(s).`)
      return
    }

    const loginRunning = await ctx.daemon.forCommand('login').isRunning()
    const state = await readJson<LoginState | null>(loginStatePath(), null)
    if (state?.provider === id && loginRunning && state.status === 'pending') {
      ctx.console.error(`Login to ${id} is in progress.`)
      if (state.instructions) ctx.console.error(state.instructions)
      if (state.url) ctx.console.error(state.url)
      exit(ctx, 1)
    }
    if (state?.provider === id && state.status === 'error') {
      fail(ctx, state.error ?? `Login to ${id} failed`)
    }
    fail(ctx, `Not logged in to ${id}. Run \`subrouter login ${id}\`.`)
  })

cli
  .command('account remove <provider> <indexOrEmail>', 'Remove one account from a provider pool')
  .option('--force', 'Skip confirmation')
  .example('subrouter account remove anthropic 2')
  .example('subrouter account remove openai me@example.com')
  .action(async (provider, indexOrEmail, options, ctx) => {
    if (!isProviderId(provider)) {
      fail(ctx, `Unknown provider ${provider}. Valid providers: ${PROVIDER_IDS.join(', ')}`)
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
    const target = pool?.accounts[index]
    if (!target) fail(ctx, `Account ${indexOrEmail} does not exist for ${provider}`)
    await confirmDestructive({
      force: Boolean(options.force),
      message: `Remove ${provider} account ${accountLabel(target)}?`,
      nonInteractiveMessage: 'Use --force to remove an account non-interactively',
      ctx,
    })
    const removed = await removeAccount({ provider, index })
    if (removed instanceof Error) fail(ctx, removed.message)
    ctx.console.log(`Removed ${provider} account ${accountLabel(removed)}`)
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
      if (typeof input !== 'string' || !input) exit(ctx, 0)
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
  .command('preset show <name>', 'Show one preset and its current usable candidates')
  .action(async (name, _options, ctx) => {
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
  .command('preset remove <name>', 'Delete a preset')
  .option('--force', 'Skip confirmation')
  .action(async (name, options, ctx) => {
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
