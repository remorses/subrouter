import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  accountKey,
  accountLabel,
  addAccount,
  configFilePath,
  cooldownKey,
  isCoolingDown,
  loadAccounts,
  loadLoginState,
  loadPresets,
  loadState,
  markCooldown,
  orderAccounts,
  removeAccount,
  removePreset,
  saveLoginState,
  savePreset,
  subrouterHome,
  updateAccount,
  writeJson,
  type StoredAccount,
} from './store.ts'
import { configJsonSchema, SCHEMA_URL } from './schemas.ts'

let home: string

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'subrouter-store-'))
  process.env.SUBROUTER_HOME = home
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('test home isolation', () => {
  test('refuses to use ~/.subrouter while vitest is running', () => {
    delete process.env.SUBROUTER_HOME
    expect(() => subrouterHome()).toThrow(/SUBROUTER_HOME/)
  })

  test('refuses SUBROUTER_HOME pointed at ~/.subrouter', () => {
    process.env.SUBROUTER_HOME = path.join(homedir(), '.subrouter')
    expect(() => subrouterHome()).toThrow(/SUBROUTER_HOME/)
  })
})

function oauthAccount(overrides: Partial<StoredAccount> = {}): StoredAccount {
  return {
    type: 'oauth',
    refresh: 'refresh-1',
    access: 'access-1',
    expires: Date.now() + 60_000,
    addedAt: 1000,
    lastUsed: 1000,
    ...overrides,
  }
}

describe('JSON persistence', () => {
  test('atomically replaces the prior complete file', async () => {
    const filePath = path.join(home, 'atomic.json')
    const previous = JSON.stringify({ version: 1, value: 'previous' }, null, 2) + '\n'
    await writeFile(filePath, previous)
    await using previousFile = await open(filePath, 'r')

    await writeJson(filePath, { version: 1, value: 'replacement' })

    const previousContents = await previousFile.readFile('utf8')
    const replacementContents = await open(filePath, 'r').then(async (replacementFile) => {
      await using file = replacementFile
      return file.readFile('utf8')
    })
    const mode = (await stat(filePath)).mode & 0o777

    expect({ previousContents, replacementContents, mode, files: await readdir(home) })
      .toMatchInlineSnapshot(`
        {
          "files": [
            "atomic.json",
          ],
          "mode": 384,
          "previousContents": "{
          "version": 1,
          "value": "previous"
        }
        ",
          "replacementContents": "{
          "version": 1,
          "value": "replacement"
        }
        ",
        }
      `)
  })

  test('removes the temporary file when replacement fails', async () => {
    const filePath = path.join(home, 'blocked.json')
    const priorStatePath = path.join(filePath, 'prior-state.json')
    await mkdir(filePath)
    await writeFile(priorStatePath, '{"prior":true}\n')

    await expect(writeJson(filePath, { replacement: true })).rejects.toThrow()

    expect({ files: await readdir(home), priorState: await readFile(priorStatePath, 'utf8') })
      .toMatchInlineSnapshot(`
        {
          "files": [
            "blocked.json",
          ],
          "priorState": "{\"prior\":true}
        ",
        }
      `)
  })
})

describe('accounts', () => {
  test('JSON schema exposes the config fields', () => {
    expect(Object.keys(configJsonSchema.properties ?? {})).toMatchInlineSnapshot(`
      [
        "$schema",
        "version",
        "providers",
        "presets",
        "cooldowns",
        "routes",
        "logins",
      ]
    `)
  })

  test('writes $schema on config.json', async () => {
    await addAccount({ provider: 'anthropic', account: oauthAccount({ email: 'a@x.com' }) })
    expect(JSON.parse(await readFile(configFilePath(), 'utf8')).$schema).toBe(SCHEMA_URL)
  })

  test('merges split 0.3.0 state files into config.json on first load', async () => {
    await writeFile(
      path.join(home, 'accounts.json'),
      JSON.stringify({
        version: 1,
        providers: {
          anthropic: { activeIndex: 0, accounts: [oauthAccount({ email: 'a@x.com' })] },
          opencode: {
            activeIndex: 0,
            accounts: [{ type: 'api', key: 'go-key', addedAt: 1, lastUsed: 1 }],
          },
        },
      }) + '\n',
    )
    await writeFile(
      path.join(home, 'presets.json'),
      JSON.stringify({
        version: 1,
        presets: { work: ['anthropic/claude-opus-4-6', 'opencode/grok-4.6'] },
      }) + '\n',
    )
    await writeFile(
      path.join(home, 'state.json'),
      JSON.stringify({ version: 1, cooldowns: { 'anthropic:a@x.com': Date.now() + 60_000 } }) + '\n',
    )
    await writeFile(
      path.join(home, 'login-openai.json'),
      JSON.stringify({
        provider: 'openai',
        status: 'pending',
        url: 'https://auth.openai.com/example',
      }) + '\n',
    )

    const accounts = await loadAccounts()
    const presets = await loadPresets()
    const state = await loadState()
    const login = await loadLoginState('openai')

    expect(accounts.providers.anthropic?.accounts.map((account) => account.email)).toEqual(['a@x.com'])
    expect(accounts.providers['opencode-go']?.accounts.map((account) => account.key)).toEqual(['go-key'])
    expect(presets.presets).toEqual({ work: ['anthropic/claude-opus-4-6', 'opencode-go/grok-4.6'] })
    expect(state.cooldowns['anthropic:a@x.com']).toBeGreaterThan(Date.now())
    expect(login?.status).toBe('pending')

    await addAccount({
      provider: 'xai',
      account: oauthAccount({ refresh: 'x-refresh', access: 'x-access', email: 'x@x.com' }),
    })
    const config = JSON.parse(await readFile(configFilePath(), 'utf8'))
    expect(config.providers.anthropic.accounts[0].email).toBe('a@x.com')
    expect(config.providers['opencode-go'].accounts[0].key).toBe('go-key')
    expect(config.presets.work).toEqual(['anthropic/claude-opus-4-6', 'opencode-go/grok-4.6'])
    expect((await readdir(home)).sort()).toEqual(['config.json'])
  })

  test('adding an account clears the provider login state', async () => {
    await saveLoginState({
      provider: 'anthropic',
      status: 'error',
      error: 'earlier login failed',
    })

    await addAccount({ provider: 'anthropic', account: oauthAccount() })

    expect(await loadLoginState('anthropic')).toBeNull()
  })

  test('add, upsert and remove accounts', async () => {
    await addAccount({ provider: 'anthropic', account: oauthAccount({ email: 'a@x.com' }) })
    await addAccount({
      provider: 'anthropic',
      account: oauthAccount({ refresh: 'refresh-2', access: 'access-2', email: 'b@x.com' }),
    })
    // Same email upserts instead of duplicating
    await addAccount({
      provider: 'anthropic',
      account: oauthAccount({ refresh: 'refresh-2b', access: 'access-2b', email: 'b@x.com' }),
    })

    const file = await loadAccounts()
    const pool = file.providers.anthropic!
    expect(pool.accounts.map((a) => [a.email, a.refresh])).toMatchInlineSnapshot(`
      [
        [
          "a@x.com",
          "refresh-1",
        ],
        [
          "b@x.com",
          "refresh-2b",
        ],
      ]
    `)
    expect(pool.activeIndex).toBe(1)

    const removed = await removeAccount({ provider: 'anthropic', index: 0 })
    expect(removed instanceof Error).toBe(false)
    const after = await loadAccounts()
    expect(after.providers.anthropic!.accounts.map((a) => a.email)).toEqual(['b@x.com'])
    expect(after.providers.anthropic!.activeIndex).toBe(0)
  })

  test('updateAccount persists refreshed tokens', async () => {
    await addAccount({ provider: 'xai', account: oauthAccount({ email: 'x@x.com' }) })
    await updateAccount({
      provider: 'xai',
      match: oauthAccount({ email: 'x@x.com' }),
      update: { access: 'access-new', refresh: 'refresh-new' },
    })
    const file = await loadAccounts()
    expect(file.providers.xai!.accounts[0]!.access).toBe('access-new')
    expect(file.providers.xai!.accounts[0]!.refresh).toBe('refresh-new')
  })

  test('accountKey and label prefer identity', () => {
    const account = oauthAccount({ email: 'Someone@X.com' })
    expect(accountKey(account)).toBe('someone@x.com')
    expect(accountLabel(account, 0)).toBe('#1 (Someone@X.com)')
  })

  test('orderAccounts ranks every email and rejects incomplete lists', async () => {
    await addAccount({ provider: 'anthropic', account: oauthAccount({ email: 'a@x.com' }) })
    await addAccount({
      provider: 'anthropic',
      account: oauthAccount({ refresh: 'refresh-2', access: 'access-2', email: 'b@x.com' }),
    })
    await addAccount({
      provider: 'anthropic',
      account: oauthAccount({ refresh: 'refresh-3', access: 'access-3', email: 'c@x.com' }),
    })

    const incomplete = await orderAccounts({
      provider: 'anthropic',
      emails: ['c@x.com', 'a@x.com'],
    })
    expect(incomplete instanceof Error).toBe(true)
    expect(incomplete).toMatchInlineSnapshot(`[StoreError: Subrouter store error: List every anthropic email exactly once: a@x.com b@x.com c@x.com]`)

    const unknown = await orderAccounts({
      provider: 'anthropic',
      emails: ['c@x.com', 'a@x.com', 'nope@x.com'],
    })
    expect(unknown instanceof Error).toBe(true)
    expect(unknown).toMatchInlineSnapshot(`[StoreError: Subrouter store error: unknown email nope@x.com. List every anthropic email exactly once: a@x.com b@x.com c@x.com]`)

    const ordered = await orderAccounts({
      provider: 'anthropic',
      emails: ['C@x.com', 'a@x.com', 'b@x.com'],
    })
    expect(ordered instanceof Error).toBe(false)
    const pool = (await loadAccounts()).providers.anthropic!
    expect(pool.accounts.map((account) => account.email)).toEqual(['c@x.com', 'a@x.com', 'b@x.com'])
    expect(pool.activeIndex).toBe(0)
  })
})

describe('cooldowns', () => {
  test('mark, read and expire cooldowns', async () => {
    const account = oauthAccount({ email: 'a@x.com' })
    await markCooldown({ provider: 'anthropic', account, untilMs: Date.now() + 60_000 })
    const state = await loadState()
    expect(isCoolingDown({ state, provider: 'anthropic', account })).toBe(true)
    expect(Object.keys(state.cooldowns)).toEqual([cooldownKey({ provider: 'anthropic', account })])

    // Expired entries are dropped on load
    await markCooldown({ provider: 'xai', account, untilMs: Date.now() - 1 })
    const state2 = await loadState()
    expect(isCoolingDown({ state: state2, provider: 'xai', account })).toBe(false)
  })

  test('never shortens an existing cooldown', async () => {
    const account = oauthAccount({ email: 'a@x.com' })
    const far = Date.now() + 100_000
    await markCooldown({ provider: 'anthropic', account, untilMs: far })
    await markCooldown({ provider: 'anthropic', account, untilMs: Date.now() + 1_000 })
    const state = await loadState()
    expect(state.cooldowns[cooldownKey({ provider: 'anthropic', account })]).toBe(far)
  })
})

describe('presets', () => {
  test('save, load and remove presets', async () => {
    await savePreset({ name: 'work', models: ['anthropic/claude-opus-4-6', 'xai/grok-4.6'] })
    const presets = await loadPresets()
    expect(presets.presets).toMatchInlineSnapshot(`
      {
        "work": [
          "anthropic/claude-opus-4-6",
          "xai/grok-4.6",
        ],
      }
    `)
    const removed = await removePreset('work')
    expect(removed).toBeNull()
    const after = await loadPresets()
    expect(after.presets).toEqual({})
    const missing = await removePreset('nope')
    expect(missing instanceof Error).toBe(true)
  })
})
