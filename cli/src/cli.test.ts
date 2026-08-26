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
  markCooldown,
  savePreset,
  type StoredAccount,
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
        env: { ...process.env, AI_AGENT: 'codex', SUBROUTER_HOME: home },
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
  test('exits nonzero until the provider has an account', async () => {
    expect((await runCli('account', 'status', 'anthropic')).code).toBe(1)

    await addAccount({ provider: 'anthropic', account })
    expect((await runCli('account', 'status', 'anthropic')).code).toBe(0)
  })

  test('stores non-interactive key input without printing the secret', async () => {
    const result = await runCli('login', 'minimax', '--input', 'subscription-key')

    expect(result.code).toBe(0)
    expect(`${result.stdout}${result.stderr}`).not.toContain('subscription-key')
    expect((await loadAccounts()).providers.minimax?.accounts).toMatchObject([
      { type: 'api', key: 'subscription-key' },
    ])
  })
})
