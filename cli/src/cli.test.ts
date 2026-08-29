/** Exercises the published CLI entry against real local state. */

import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  addAccount,
  loadAccounts,
  loadPresets,
  loadState,
  loginStatePath,
  markCooldown,
  readJson,
  savePreset,
  type StoredAccount,
  writeJson,
} from './store.ts'

const execFileAsync = promisify(execFile)
const packageRoot = path.resolve(import.meta.dirname, '..')

async function runCli(...args: string[]): Promise<{
  code: number
  stderr: string
  stdout: string
}> {
  try {
    const result = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', 'src/bin.ts', ...args],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          AI_AGENT: 'codex',
          HOME: home,
          SUBROUTER_HOME: home,
          SUBROUTER_MANUAL_OAUTH: '',
        },
      },
    )
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (cause) {
    const error = cause as Error & { code: number; stdout: string; stderr: string }
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

const account: StoredAccount = {
  type: 'api',
  key: 'secret-key',
  email: 'tommy@example.com',
  addedAt: 1,
  lastUsed: 1,
}

let home: string

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'subrouter-cli-'))
  process.env.SUBROUTER_HOME = home
})

afterEach(async () => {
  delete process.env.SUBROUTER_HOME
  await rm(home, { recursive: true, force: true })
})

describe('destructive commands', () => {
  test('require --force in agent mode and preserve state otherwise', async () => {
    await addAccount({ provider: 'anthropic', account })
    await savePreset({ name: 'work', models: ['anthropic/claude-opus-4-6'] })
    await markCooldown({ provider: 'anthropic', account, untilMs: Date.now() + 60_000 })

    const logout = await runCli('logout', 'anthropic')
    const removeAccount = await runCli('account', 'remove', 'anthropic', '1')
    const removePreset = await runCli('preset', 'remove', 'work')
    const overwritePreset = await runCli(
      'preset',
      'create',
      'work',
      '--models',
      'anthropic/claude-opus-4-6',
    )
    const clearCooldown = await runCli('cooldown', 'clear')

    for (const result of [logout, removeAccount, removePreset, overwritePreset, clearCooldown]) {
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('--force')
    }
    expect((await loadAccounts()).providers.anthropic?.accounts).toHaveLength(1)
    expect((await loadPresets()).presets.work).toEqual(['anthropic/claude-opus-4-6'])
    expect(Object.keys((await loadState()).cooldowns)).toHaveLength(1)
  })
})

describe('account status', () => {
  test(
    'tracks concurrent login jobs independently by provider',
    async () => {
      try {
        const [openai, poe] = await Promise.all([
          runCli('login', 'openai', '--method', 'browser'),
          runCli('login', 'poe'),
        ])
        expect(
          [openai.code, poe.code],
          JSON.stringify({ openai, poe }, null, 2),
        ).toEqual([0, 0])

        const [openaiStatus, poeStatus] = await Promise.all([
          runCli('account', 'status', 'openai'),
          runCli('account', 'status', 'poe'),
        ])
        expect(openaiStatus.stderr).toContain('Login to openai is in progress.')
        expect(poeStatus.stderr).toContain('Login to poe is in progress.')
      } finally {
        await Promise.all([
          runCli('logout', 'openai', '--force'),
          runCli('logout', 'poe', '--force'),
        ])
      }
    },
    15_000,
  )

  test('exits nonzero until the provider has an account', async () => {
    expect((await runCli('account', 'status', 'anthropic')).code).toBe(1)

    await addAccount({ provider: 'anthropic', account })
    expect((await runCli('account', 'status', 'anthropic')).code).toBe(0)
  })

  // A stale account must never mask a login that is still running: the old
  // token is usually the expired one the user is replacing right now.
  test(
    'a running login outranks an already stored account',
    async () => {
      await addAccount({ provider: 'poe', account })
      try {
        const login = await runCli('login', 'poe')
        expect(login.code).toBe(0)
        // The whole point of a background login: the human reading a chat window
        // must get the authorize URL, exactly once, without a second command.
        expect(`${login.stdout}${login.stderr}`.match(/poe\.com\/oauth\/authorize/g)).toHaveLength(1)

        const status = await runCli('account', 'status', 'poe')
        expect(status.code).toBe(1)
        expect(status.stderr).toContain('Login to poe is in progress.')
        // The replay hint is the whole point of printing instructions again.
        expect(status.stderr).toContain("curl 'http://127.0.0.1:")
        expect(status.stderr.match(/poe\.com\/oauth\/authorize/g)).toHaveLength(1)
      } finally {
        await runCli('logout', 'poe', '--force')
      }
    },
    15_000,
  )

  test('a failed login stays visible until the next login succeeds', async () => {
    await addAccount({ provider: 'minimax', account })
    await writeJson(path.join(home, 'login-minimax.json'), {
      provider: 'minimax',
      status: 'error',
      error: 'MiniMax auth failed: timed out waiting for OAuth callback',
    })

    const failed = await runCli('account', 'status', 'minimax')
    expect(failed.code).toBe(1)
    expect(failed.stderr).toContain('timed out waiting for OAuth callback')

    expect((await runCli('login', 'minimax', '--input', 'subscription-key')).code).toBe(0)
    expect((await runCli('account', 'status', 'minimax')).code).toBe(0)
  })

  test('a dead login clears its pending state and falls through to stored accounts', async () => {
    const loginPath = loginStatePath('anthropic')
    await addAccount({ provider: 'anthropic', account })
    await writeJson(loginPath, { provider: 'anthropic', status: 'pending' })

    const status = await runCli('account', 'status', 'anthropic')

    expect(status.code).toBe(0)
    expect(status.stderr).toContain('Login to anthropic stopped before it finished.')
    expect(status.stdout).toContain('Logged in to anthropic with 1 account(s).')
    expect(await readJson(loginPath, null)).toBeNull()
  })

  test('stores non-interactive key input without printing the secret', async () => {
    const result = await runCli('login', 'minimax', '--input', 'subscription-key')

    expect(result.code).toBe(0)
    expect(`${result.stdout}${result.stderr}`).not.toContain('subscription-key')
    expect((await loadAccounts()).providers.minimax?.accounts).toMatchObject([
      { type: 'api', key: 'subscription-key' },
    ])
  })

  test('prints the OpenCode Go key page instead of starting a browser login', async () => {
    const result = await runCli('login', 'opencode-go', '--input', 'go-key-1')

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('https://opencode.ai/auth')
    expect((await loadAccounts()).providers['opencode-go']?.accounts).toMatchObject([
      { type: 'api', key: 'go-key-1' },
    ])
  })
})
