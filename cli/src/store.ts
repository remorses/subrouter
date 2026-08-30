/**
 * Subrouter local state: accounts, login attempts, presets and cooldowns.
 *
 * Everything lives under ~/.subrouter (override with SUBROUTER_HOME, used by
 * tests). Files are atomically replaced JSON with 0600 permissions and a lock
 * directory for cross-process safety. The cooldown state is global on purpose:
 * when a subscription hits a rate limit, every process and harness on the
 * machine should stop retrying it until the cooldown expires.
 */

import * as errore from 'errore'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  ACCOUNTS_SCHEMA_URL,
  LOGIN_SCHEMA_URL,
  PRESETS_SCHEMA_URL,
  PROVIDER_IDS,
  STATE_SCHEMA_URL,
  type AccountsFile,
  type LoginState,
  type PresetsFile,
  type ProviderAccounts,
  type ProviderId,
  type StateFile,
  type StoredAccount,
} from './schemas.ts'

export {
  PROVIDER_IDS,
  type AccountsFile,
  type LoginState,
  type PresetsFile,
  type ProviderAccounts,
  type ProviderId,
  type StateFile,
  type StoredAccount,
}

export function isProviderId(value: string): value is ProviderId {
  return PROVIDER_IDS.some((provider) => provider === value)
}

export class StoreError extends errore.createTaggedError({
  name: 'StoreError',
  message: 'Subrouter store error: $reason',
}) {}

// --- Paths ---

export function subrouterHome() {
  if (process.env.SUBROUTER_HOME) return process.env.SUBROUTER_HOME
  return path.join(os.homedir(), '.subrouter')
}

export function accountsFilePath() {
  return path.join(subrouterHome(), 'accounts.json')
}

export function presetsFilePath() {
  return path.join(subrouterHome(), 'presets.json')
}

export function stateFilePath() {
  return path.join(subrouterHome(), 'state.json')
}

export function loginStatePath(provider: ProviderId) {
  return path.join(subrouterHome(), `login-${provider}.json`)
}

// --- JSON I/O ---

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  const raw = await fs.readFile(filePath, 'utf8').catch(() => null)
  if (raw === null) return fallback
  const parsed = errore.try(() => JSON.parse(raw) as T)
  if (parsed instanceof Error) return fallback
  return parsed
}

function schemaUrlFor(filePath: string) {
  const name = path.basename(filePath)
  if (name === 'accounts.json') return ACCOUNTS_SCHEMA_URL
  if (name === 'presets.json') return PRESETS_SCHEMA_URL
  if (name === 'state.json') return STATE_SCHEMA_URL
  if (name.startsWith('login-') && name.endsWith('.json')) return LOGIN_SCHEMA_URL
  return null
}

export async function writeJson(filePath: string, value: object) {
  const directory = path.dirname(filePath)
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  )
  await fs.mkdir(directory, { recursive: true })
  const schema = schemaUrlFor(filePath)
  const payload = schema ? { $schema: schema, ...value } : value

  try {
    const temporaryFile = await fs.open(temporaryPath, 'wx', 0o600)
    try {
      await temporaryFile.writeFile(JSON.stringify(payload, null, 2) + '\n', 'utf8')
      await temporaryFile.sync()
    } finally {
      await temporaryFile.close()
    }
    await fs.rename(temporaryPath, filePath)
  } catch (error) {
    const cleanupError = await fs.rm(temporaryPath, { force: true }).then(
      () => null,
      (cause) => cause,
    )
    if (cleanupError) {
      throw new AggregateError([error, cleanupError], `Failed to replace JSON file ${filePath}`)
    }
    throw error
  }
}

// --- Locking (lock directory, stale after 30s) ---

const LOCK_STALE_MS = 30_000
const LOCK_RETRY_MS = 100

async function sleep(ms: number) {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

export async function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockDir = path.join(subrouterHome(), '.lock')
  const deadline = Date.now() + LOCK_STALE_MS
  await fs.mkdir(subrouterHome(), { recursive: true })

  while (true) {
    const created = await fs.mkdir(lockDir).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST') return false
        throw error
      },
    )
    if (created) break

    const stats = await fs.stat(lockDir).catch(() => null)
    if (stats && Date.now() - stats.mtimeMs > LOCK_STALE_MS) {
      await fs.rm(lockDir, { force: true, recursive: true }).catch(() => {})
      continue
    }
    if (Date.now() >= deadline) {
      throw new StoreError({ reason: `timed out waiting for lock ${lockDir}` })
    }
    await sleep(LOCK_RETRY_MS)
  }

  try {
    return await fn()
  } finally {
    await fs.rm(lockDir, { force: true, recursive: true }).catch(() => {})
  }
}

// --- Accounts ---

function normalizeProviderAccounts(input: Partial<ProviderAccounts> | undefined): ProviderAccounts {
  const accounts = Array.isArray(input?.accounts)
    ? input.accounts.filter((account): account is StoredAccount => {
        if (!account || typeof account !== 'object') return false
        if (account.type === 'oauth') {
          return typeof account.refresh === 'string' && typeof account.access === 'string'
        }
        if (account.type === 'api') return typeof account.key === 'string'
        return false
      })
    : []
  const rawIndex = typeof input?.activeIndex === 'number' ? Math.floor(input.activeIndex) : 0
  const activeIndex =
    accounts.length === 0 ? 0 : ((rawIndex % accounts.length) + accounts.length) % accounts.length
  return { activeIndex, accounts }
}

export async function loadAccounts(): Promise<AccountsFile> {
  const raw = await readJson<Partial<AccountsFile> | null>(accountsFilePath(), null)
  const providers: AccountsFile['providers'] = {}
  for (const id of PROVIDER_IDS) {
    const entry = raw?.providers?.[id]
    if (!entry) continue
    providers[id] = normalizeProviderAccounts(entry)
  }
  return { version: 1, providers }
}

export async function saveAccounts(file: AccountsFile) {
  await writeJson(accountsFilePath(), file)
}

/** Stable identity key for an account, used for cooldowns and dedupe. */
export function accountKey(account: StoredAccount) {
  if (account.accountId) return account.accountId
  if (account.email) return account.email.trim().toLowerCase()
  const secret = account.refresh || account.key || account.access || ''
  return secret.length > 16 ? `${secret.slice(0, 8)}...${secret.slice(-4)}` : secret
}

export function accountLabel(account: StoredAccount, index?: number) {
  const identity =
    account.email || account.accountId || (account.type === 'api' ? 'API key' : accountKey(account))
  return index !== undefined ? `#${index + 1} (${identity})` : identity
}

export function upsertAccount(pool: ProviderAccounts, account: StoredAccount) {
  const key = accountKey(account)
  const index = pool.accounts.findIndex((existing) => {
    if (account.refresh && existing.refresh === account.refresh) return true
    if (account.access && existing.access === account.access) return true
    if (account.key && existing.key === account.key) return true
    return accountKey(existing) === key
  })
  if (index < 0) {
    pool.accounts.push(account)
    pool.activeIndex = pool.accounts.length - 1
    return pool.activeIndex
  }
  const existing = pool.accounts[index]
  if (!existing) return index
  pool.accounts[index] = {
    ...existing,
    ...account,
    addedAt: existing.addedAt,
    email: account.email || existing.email,
    accountId: account.accountId || existing.accountId,
  }
  pool.activeIndex = index
  return index
}

export async function addAccount({
  provider,
  account,
}: {
  provider: ProviderId
  account: StoredAccount
}) {
  await withStoreLock(async () => {
    const file = await loadAccounts()
    const pool = file.providers[provider] ?? { activeIndex: 0, accounts: [] }
    upsertAccount(pool, account)
    file.providers[provider] = pool
    await saveAccounts(file)
  })
  // Every harness stores successful logins through this function. Clearing the
  // state here prevents an older CLI error from masking a later harness login.
  await fs.rm(loginStatePath(provider), { force: true })
}

/** Persist updated tokens for an existing account (after a refresh). */
export async function updateAccount({
  provider,
  match,
  update,
}: {
  provider: ProviderId
  match: StoredAccount
  update: Partial<StoredAccount>
}) {
  await withStoreLock(async () => {
    const file = await loadAccounts()
    const pool = file.providers[provider]
    if (!pool) return
    const key = accountKey(match)
    const index = pool.accounts.findIndex((existing) => {
      if (match.refresh && existing.refresh === match.refresh) return true
      if (match.access && existing.access === match.access) return true
      return accountKey(existing) === key
    })
    const existing = pool.accounts[index]
    if (!existing) return
    pool.accounts[index] = { ...existing, ...update, lastUsed: Date.now() }
    await saveAccounts(file)
  })
}

export async function removeAccount({
  provider,
  index,
}: {
  provider: ProviderId
  index: number
}): Promise<StoreError | StoredAccount> {
  return withStoreLock(async () => {
    const file = await loadAccounts()
    const pool = file.providers[provider]
    if (!pool || index < 0 || index >= pool.accounts.length) {
      return new StoreError({ reason: `account ${index + 1} does not exist for ${provider}` })
    }
    const [removed] = pool.accounts.splice(index, 1)
    if (pool.activeIndex > index) pool.activeIndex -= 1
    if (pool.activeIndex >= pool.accounts.length) pool.activeIndex = 0
    await saveAccounts(file)
    return removed!
  })
}

function accountEmails(accounts: StoredAccount[]) {
  return accounts.map((account) => account.email?.trim()).filter((email): email is string => Boolean(email))
}

function orderEmailsHint({ provider, accounts }: { provider: ProviderId; accounts: StoredAccount[] }) {
  return `List every ${provider} email exactly once: ${accountEmails(accounts).join(' ')}`
}

/** Reorder a provider pool. `emails` must name every account exactly once. */
export async function orderAccounts({
  provider,
  emails,
}: {
  provider: ProviderId
  emails: string[]
}): Promise<StoreError | StoredAccount[]> {
  return withStoreLock(async () => {
    const file = await loadAccounts()
    const pool = file.providers[provider]
    if (!pool || pool.accounts.length === 0) {
      return new StoreError({ reason: `no accounts for ${provider}. Run: subrouter login ${provider}` })
    }
    if (pool.accounts.some((account) => !account.email?.trim())) {
      return new StoreError({ reason: `every ${provider} account needs an email before it can be ordered` })
    }
    const wanted = emails.map((email) => email.trim().toLowerCase()).filter(Boolean)
    if (wanted.length !== pool.accounts.length) {
      return new StoreError({ reason: orderEmailsHint({ provider, accounts: pool.accounts }) })
    }
    const duplicate = wanted.find((email, index) => wanted.indexOf(email) !== index)
    if (duplicate) {
      return new StoreError({
        reason: `duplicate email ${duplicate}. ${orderEmailsHint({ provider, accounts: pool.accounts })}`,
      })
    }
    const byEmail = new Map(
      pool.accounts.map((account) => [account.email!.trim().toLowerCase(), account] as const),
    )
    const unknown = wanted.find((email) => !byEmail.has(email))
    if (unknown) {
      return new StoreError({
        reason: `unknown email ${unknown}. ${orderEmailsHint({ provider, accounts: pool.accounts })}`,
      })
    }
    pool.accounts = wanted.map((email) => byEmail.get(email)!)
    pool.activeIndex = 0
    await saveAccounts(file)
    return pool.accounts
  })
}

// --- Presets ---

export async function loadPresets(): Promise<PresetsFile> {
  const raw = await readJson<Partial<PresetsFile> | null>(presetsFilePath(), null)
  const presets: Record<string, string[]> = {}
  for (const [name, models] of Object.entries(raw?.presets ?? {})) {
    if (!Array.isArray(models)) continue
    presets[name] = models.filter((entry) => typeof entry === 'string' && entry.includes('/'))
  }
  return { version: 1, presets }
}

export async function savePreset({ name, models }: { name: string; models: string[] }) {
  await withStoreLock(async () => {
    const file = await loadPresets()
    file.presets[name] = models
    await writeJson(presetsFilePath(), file)
  })
}

export async function removePreset(name: string): Promise<StoreError | null> {
  return withStoreLock(async () => {
    const file = await loadPresets()
    if (!file.presets[name]) return new StoreError({ reason: `preset ${name} does not exist` })
    delete file.presets[name]
    await writeJson(presetsFilePath(), file)
    return null
  })
}

// --- Cooldowns ---

export async function loadState(): Promise<StateFile> {
  const raw = await readJson<Partial<StateFile> | null>(stateFilePath(), null)
  const cooldowns: Record<string, number> = {}
  for (const [key, until] of Object.entries(raw?.cooldowns ?? {})) {
    if (typeof until !== 'number') continue
    if (until <= Date.now()) continue
    cooldowns[key] = until
  }
  return { version: 1, cooldowns }
}

export function cooldownKey({ provider, account }: { provider: ProviderId; account: StoredAccount }) {
  return `${provider}:${accountKey(account)}`
}

export async function markCooldown({
  provider,
  account,
  untilMs,
}: {
  provider: ProviderId
  account: StoredAccount
  untilMs: number
}) {
  await withStoreLock(async () => {
    const state = await loadState()
    const key = cooldownKey({ provider, account })
    const existing = state.cooldowns[key]
    // Never shorten an existing cooldown
    state.cooldowns[key] = Math.max(existing ?? 0, untilMs)
    await writeJson(stateFilePath(), state)
  })
}

export async function clearCooldowns() {
  await withStoreLock(async () => {
    await writeJson(stateFilePath(), { version: 1, cooldowns: {} } satisfies StateFile)
  })
}

export function isCoolingDown({
  state,
  provider,
  account,
  now = Date.now(),
}: {
  state: StateFile
  provider: ProviderId
  account: StoredAccount
  now?: number
}) {
  const until = state.cooldowns[cooldownKey({ provider, account })]
  return typeof until === 'number' && until > now
}
