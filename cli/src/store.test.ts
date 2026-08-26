import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  accountKey,
  accountLabel,
  addAccount,
  cooldownKey,
  isCoolingDown,
  loadAccounts,
  loadPresets,
  loadState,
  markCooldown,
  removeAccount,
  removePreset,
  savePreset,
  updateAccount,
  type StoredAccount,
} from './store.ts'

let home: string

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'subrouter-store-'))
  process.env.SUBROUTER_HOME = home
})

afterEach(async () => {
  delete process.env.SUBROUTER_HOME
  await rm(home, { recursive: true, force: true })
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

describe('accounts', () => {
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
