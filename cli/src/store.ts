/**
 * Subrouter local state: accounts, login attempts, presets and cooldowns.
 *
 * Everything lives in ~/.subrouter/config.json (override with SUBROUTER_HOME,
 * used by tests). The file is atomically replaced JSON with 0600 permissions
 * and a lock directory for cross-process safety. Cooldown state is global on
 * purpose: when a subscription hits a rate limit, every process and harness
 * on the machine should stop retrying it until the cooldown expires.
 * In-flight session routes are stored here too, so /model and the OpenCode
 * system prompt can read the live provider/model from another process.
 * 0.3.0 used accounts.json, presets.json, state.json, and login-*.json.
 * Those files are read until the next write, then replaced by config.json.
 * Provider id `opencode` is copied to `opencode-go` on that load.
 */

import * as errore from 'errore'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  PROVIDER_IDS,
  SCHEMA_URL,
  type AccountsFile,
  type ConfigFile,
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
  type ConfigFile,
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
  const home = process.env.SUBROUTER_HOME || path.join(os.homedir(), '.subrouter')
  if (
    process.env.VITEST &&
    path.resolve(home) === path.resolve(path.join(os.homedir(), '.subrouter'))
  ) {
    throw new StoreError({ reason: 'SUBROUTER_HOME must be a temp directory in tests' })
  }
  return home
}

export function configFilePath() {
  return path.join(subrouterHome(), 'config.json')
}

// --- JSON I/O ---

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  const raw = await fs.readFile(filePath, 'utf8').catch(() => null)
  if (raw === null) return fallback
  const parsed = errore.try(() => JSON.parse(raw) as T)
  if (parsed instanceof Error) return fallback
  return parsed
}

export async function writeJson(filePath: string, value: object) {
  const directory = path.dirname(filePath)
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  )
  await fs.mkdir(directory, { recursive: true })
  const payload = path.basename(filePath) === 'config.json' ? { $schema: SCHEMA_URL, ...value } : value

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

// --- Config ---

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

function normalizeProviders(input: Partial<ConfigFile['providers']> | undefined): ConfigFile['providers'] {
  const providers: ConfigFile['providers'] = {}
  for (const id of PROVIDER_IDS) {
    const entry = input?.[id]
    if (!entry) continue
    providers[id] = normalizeProviderAccounts(entry)
  }
  return providers
}

function normalizePresets(input: Partial<ConfigFile['presets']> | undefined): ConfigFile['presets'] {
  const presets: ConfigFile['presets'] = {}
  for (const [name, models] of Object.entries(input ?? {})) {
    if (!Array.isArray(models)) continue
    presets[name] = models.filter((entry) => typeof entry === 'string' && entry.includes('/'))
  }
  return presets
}

function normalizeCooldowns(input: Partial<ConfigFile['cooldowns']> | undefined, now = Date.now()) {
  const cooldowns: ConfigFile['cooldowns'] = {}
  for (const [key, until] of Object.entries(input ?? {})) {
    if (typeof until !== 'number') continue
    if (until <= now) continue
    cooldowns[key] = until
  }
  return cooldowns
}

function normalizeRoutes(input: Partial<ConfigFile['routes']> | undefined): ConfigFile['routes'] {
  const routes: ConfigFile['routes'] = {}
  for (const [sessionID, route] of Object.entries(input ?? {})) {
    if (!route || typeof route !== 'object') continue
    if (typeof route.preset !== 'string' || !route.preset) continue
    if (!isProviderId(route.provider)) continue
    if (typeof route.modelId !== 'string' || !route.modelId) continue
    routes[sessionID] = {
      preset: route.preset,
      provider: route.provider,
      modelId: route.modelId,
    }
  }
  return routes
}

function normalizeLogins(input: Partial<ConfigFile['logins']> | undefined): ConfigFile['logins'] {
  const logins: ConfigFile['logins'] = {}
  for (const id of PROVIDER_IDS) {
    const entry = input?.[id]
    if (!entry || typeof entry !== 'object') continue
    if (entry.status !== 'pending' && entry.status !== 'error') continue
    logins[id] = { ...entry, provider: id }
  }
  return logins
}

function takeOpencodeGo<T>(input: Record<string, T> | undefined) {
  if (!input) return input
  const next = { ...input }
  if (next.opencode != null && next['opencode-go'] == null) next['opencode-go'] = next.opencode
  delete next.opencode
  return next
}

function remapOpencodePresets(input: Partial<ConfigFile['presets']> | undefined) {
  const presets: Partial<ConfigFile['presets']> = {}
  for (const [name, models] of Object.entries(input ?? {})) {
    if (!Array.isArray(models)) continue
    presets[name] = models.map((entry) =>
      typeof entry === 'string' && entry.startsWith('opencode/')
        ? `opencode-go/${entry.slice('opencode/'.length)}`
        : entry,
    )
  }
  return presets
}

function remapOpencodeCooldowns(input: Partial<ConfigFile['cooldowns']> | undefined) {
  const cooldowns: Partial<ConfigFile['cooldowns']> = {}
  for (const [key, until] of Object.entries(input ?? {})) {
    const next = key.startsWith('opencode:') ? `opencode-go:${key.slice('opencode:'.length)}` : key
    if (cooldowns[next] == null) cooldowns[next] = until
  }
  return cooldowns
}

async function loadLegacyConfig(): Promise<Partial<ConfigFile> | null> {
  const accounts = await readJson<Partial<AccountsFile> | null>(
    path.join(subrouterHome(), 'accounts.json'),
    null,
  )
  const presets = await readJson<Partial<PresetsFile> | null>(
    path.join(subrouterHome(), 'presets.json'),
    null,
  )
  const state = await readJson<Partial<StateFile> | null>(path.join(subrouterHome(), 'state.json'), null)
  const logins: Record<string, LoginState> = {}
  for (const id of ['opencode', ...PROVIDER_IDS]) {
    const entry = await readJson<LoginState | null>(path.join(subrouterHome(), `login-${id}.json`), null)
    if (entry) logins[id] = entry
  }
  if (!accounts && !presets && !state && Object.keys(logins).length === 0) return null
  return {
    providers: accounts?.providers,
    presets: presets?.presets,
    cooldowns: state?.cooldowns,
    logins,
  }
}

function configFromRaw(raw: Partial<ConfigFile> | null): ConfigFile {
  return {
    version: 1,
    providers: normalizeProviders(takeOpencodeGo(raw?.providers)),
    presets: normalizePresets(remapOpencodePresets(raw?.presets)),
    cooldowns: normalizeCooldowns(remapOpencodeCooldowns(raw?.cooldowns)),
    routes: normalizeRoutes(raw?.routes),
    logins: normalizeLogins(takeOpencodeGo(raw?.logins)),
  }
}

async function loadConfigUnlocked(): Promise<ConfigFile> {
  const raw = await readJson<Partial<ConfigFile> | null>(configFilePath(), null)
  if (raw) return configFromRaw(raw)
  return configFromRaw(await loadLegacyConfig())
}

async function removeLegacyStateFiles() {
  const names = await fs.readdir(subrouterHome()).catch(() => [])
  await Promise.all(
    names
      .filter(
        (name) =>
          name === 'accounts.json' ||
          name === 'presets.json' ||
          name === 'state.json' ||
          (name.startsWith('login-') && name.endsWith('.json')),
      )
      .map((name) => fs.rm(path.join(subrouterHome(), name), { force: true })),
  )
}

async function saveConfigUnlocked(file: ConfigFile) {
  await writeJson(configFilePath(), {
    version: 1,
    providers: file.providers,
    presets: file.presets,
    cooldowns: file.cooldowns,
    routes: file.routes,
    logins: file.logins,
  })
  await removeLegacyStateFiles()
}

export async function loadAccounts(): Promise<AccountsFile> {
  const config = await loadConfigUnlocked()
  return { version: 1, providers: config.providers }
}

export async function saveAccounts(file: AccountsFile) {
  const config = await loadConfigUnlocked()
  config.providers = file.providers
  await saveConfigUnlocked(config)
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
    const config = await loadConfigUnlocked()
    const pool = config.providers[provider] ?? { activeIndex: 0, accounts: [] }
    upsertAccount(pool, account)
    config.providers[provider] = pool
    delete config.logins[provider]
    await saveConfigUnlocked(config)
  })
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
    const config = await loadConfigUnlocked()
    const pool = config.providers[provider]
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
    await saveConfigUnlocked(config)
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
    const config = await loadConfigUnlocked()
    const pool = config.providers[provider]
    if (!pool || index < 0 || index >= pool.accounts.length) {
      return new StoreError({ reason: `account ${index + 1} does not exist for ${provider}` })
    }
    const [removed] = pool.accounts.splice(index, 1)
    if (pool.activeIndex > index) pool.activeIndex -= 1
    if (pool.activeIndex >= pool.accounts.length) pool.activeIndex = 0
    await saveConfigUnlocked(config)
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
    const config = await loadConfigUnlocked()
    const pool = config.providers[provider]
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
    await saveConfigUnlocked(config)
    return pool.accounts
  })
}

export async function loadPresets(): Promise<PresetsFile> {
  const config = await loadConfigUnlocked()
  return { version: 1, presets: config.presets }
}

export async function savePreset({ name, models }: { name: string; models: string[] }) {
  await withStoreLock(async () => {
    const config = await loadConfigUnlocked()
    config.presets[name] = models
    await saveConfigUnlocked(config)
  })
}

export async function removePreset(name: string): Promise<StoreError | null> {
  return withStoreLock(async () => {
    const config = await loadConfigUnlocked()
    if (!config.presets[name]) return new StoreError({ reason: `preset ${name} does not exist` })
    delete config.presets[name]
    await saveConfigUnlocked(config)
    return null
  })
}

export async function loadState(): Promise<StateFile> {
  const config = await loadConfigUnlocked()
  return { version: 1, cooldowns: config.cooldowns }
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
    const config = await loadConfigUnlocked()
    const key = cooldownKey({ provider, account })
    const existing = config.cooldowns[key]
    config.cooldowns[key] = Math.max(existing ?? 0, untilMs)
    await saveConfigUnlocked(config)
  })
}

export async function clearCooldowns() {
  await withStoreLock(async () => {
    const config = await loadConfigUnlocked()
    config.cooldowns = {}
    await saveConfigUnlocked(config)
  })
}

export async function getLiveRoute(sessionID: string) {
  const config = await loadConfigUnlocked()
  return config.routes[sessionID] ?? null
}

export async function setLiveRoute({
  sessionID,
  preset,
  provider,
  modelId,
}: {
  sessionID: string
  preset: string
  provider: ProviderId
  modelId: string
}) {
  await withStoreLock(async () => {
    const config = await loadConfigUnlocked()
    const existing = config.routes[sessionID]
    if (
      existing &&
      existing.preset === preset &&
      existing.provider === provider &&
      existing.modelId === modelId
    ) {
      return
    }
    config.routes[sessionID] = { preset, provider, modelId }
    await saveConfigUnlocked(config)
  })
}

export async function clearLiveRoute(sessionID: string) {
  await withStoreLock(async () => {
    const config = await loadConfigUnlocked()
    if (!config.routes[sessionID]) return
    delete config.routes[sessionID]
    await saveConfigUnlocked(config)
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

export async function loadLoginState(provider: ProviderId): Promise<LoginState | null> {
  const config = await loadConfigUnlocked()
  return config.logins[provider] ?? null
}

export async function saveLoginState(state: LoginState) {
  await withStoreLock(async () => {
    const config = await loadConfigUnlocked()
    config.logins[state.provider] = state
    await saveConfigUnlocked(config)
  })
}

export async function clearLoginState(provider: ProviderId) {
  await withStoreLock(async () => {
    const config = await loadConfigUnlocked()
    delete config.logins[provider]
    await saveConfigUnlocked(config)
  })
}
