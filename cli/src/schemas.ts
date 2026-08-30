/**
 * Zod schemas for ~/.subrouter JSON files. Compiled to JSON Schema and
 * served at subrouter.org so editors and agents can autocomplete.
 */

import { z } from 'zod'

export const PROVIDER_IDS = [
  'anthropic',
  'openai',
  'xai',
  'opencode-go',
  'github-copilot',
  'poe',
  'minimax',
  'kimi',
  'zai',
  'alibaba',
] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]

export const SCHEMA_ORIGIN = 'https://subrouter.org'
export const ACCOUNTS_SCHEMA_URL = `${SCHEMA_ORIGIN}/accounts.json`
export const PRESETS_SCHEMA_URL = `${SCHEMA_ORIGIN}/presets.json`
export const STATE_SCHEMA_URL = `${SCHEMA_ORIGIN}/state.json`
export const LOGIN_SCHEMA_URL = `${SCHEMA_ORIGIN}/login.json`

const providerIdSchema = z.enum(PROVIDER_IDS).describe('Subscription provider id')

export const storedAccountSchema = z
  .object({
    type: z.enum(['oauth', 'api']).describe('oauth accounts carry refresh/access/expires, api accounts carry key'),
    refresh: z.string().optional().describe('OAuth refresh token'),
    access: z.string().optional().describe('OAuth access token'),
    expires: z.number().optional().describe('Access token expiry as epoch milliseconds'),
    key: z.string().optional().describe('API key for api accounts'),
    email: z.string().optional().describe('Account email when the provider returns one'),
    accountId: z.string().optional().describe('Provider account id when the provider returns one'),
    addedAt: z.number().describe('Epoch milliseconds when the account was first stored'),
    lastUsed: z.number().describe('Epoch milliseconds when the account was last used'),
  })
  .describe('One stored subscription account')

export const providerAccountsSchema = z
  .object({
    activeIndex: z.number().int().min(0).describe('Index of the account tried first for this provider'),
    accounts: z.array(storedAccountSchema).describe('Accounts in rotation order'),
  })
  .describe('Account pool for one provider')

export const accountsFileSchema = z
  .object({
    $schema: z.string().optional().describe('JSON Schema URL for editor autocomplete'),
    version: z.literal(1),
    providers: z
      .object({
        anthropic: providerAccountsSchema.optional(),
        openai: providerAccountsSchema.optional(),
        xai: providerAccountsSchema.optional(),
        'opencode-go': providerAccountsSchema.optional(),
        'github-copilot': providerAccountsSchema.optional(),
        poe: providerAccountsSchema.optional(),
        minimax: providerAccountsSchema.optional(),
        kimi: providerAccountsSchema.optional(),
        zai: providerAccountsSchema.optional(),
        alibaba: providerAccountsSchema.optional(),
      })
      .describe('Logged-in accounts grouped by provider'),
  })
  .describe('~/.subrouter/accounts.json')

export const presetsFileSchema = z
  .object({
    $schema: z.string().optional().describe('JSON Schema URL for editor autocomplete'),
    version: z.literal(1),
    presets: z
      .record(z.string(), z.array(z.string()).describe('Ranked provider/model entries such as anthropic/claude-opus-4-6'))
      .describe('Named presets. Each value is the failover order for that preset'),
  })
  .describe('~/.subrouter/presets.json')

export const stateFileSchema = z
  .object({
    $schema: z.string().optional().describe('JSON Schema URL for editor autocomplete'),
    version: z.literal(1),
    cooldowns: z
      .record(z.string(), z.number())
      .describe('Map of provider:accountKey to epoch milliseconds until the account is usable again'),
  })
  .describe('~/.subrouter/state.json')

export const loginStateSchema = z
  .object({
    $schema: z.string().optional().describe('JSON Schema URL for editor autocomplete'),
    provider: providerIdSchema,
    status: z.enum(['pending', 'error']).describe('pending while a login daemon waits, error after a failed attempt'),
    instructions: z.string().optional().describe('Human instructions, including device codes as code: XXXX-XXXX'),
    url: z.string().optional().describe('Authorize URL to open in a browser'),
    error: z.string().optional().describe('Failure message when status is error'),
  })
  .describe('~/.subrouter/login-<provider>.json')

export type StoredAccount = z.infer<typeof storedAccountSchema>
export type ProviderAccounts = z.infer<typeof providerAccountsSchema>
export type AccountsFile = z.infer<typeof accountsFileSchema>
export type PresetsFile = z.infer<typeof presetsFileSchema>
export type StateFile = z.infer<typeof stateFileSchema>
export type LoginState = z.infer<typeof loginStateSchema>

function toDraft7(schema: z.ZodType) {
  return z.toJSONSchema(schema, {
    target: 'draft-7',
    io: 'input',
    unrepresentable: 'any',
  })
}

export const accountsJsonSchema = toDraft7(accountsFileSchema)
export const presetsJsonSchema = toDraft7(presetsFileSchema)
export const stateJsonSchema = toDraft7(stateFileSchema)
export const loginJsonSchema = toDraft7(loginStateSchema)
