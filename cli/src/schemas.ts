/**
 * Zod schema for ~/.subrouter/config.json. Compiled to JSON Schema and
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

export const SCHEMA_URL = 'https://subrouter.org/schema.json'

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

export const loginStateSchema = z
  .object({
    provider: providerIdSchema,
    status: z.enum(['pending', 'error']).describe('pending while a login daemon waits, error after a failed attempt'),
    instructions: z.string().optional().describe('Human instructions, including device codes as code: XXXX-XXXX'),
    url: z.string().optional().describe('Authorize URL to open in a browser'),
    error: z.string().optional().describe('Failure message when status is error'),
  })
  .describe('In-progress or failed login for one provider')

const providersSchema = z
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
  .describe('Logged-in accounts grouped by provider')

const loginsSchema = z
  .object({
    anthropic: loginStateSchema.optional(),
    openai: loginStateSchema.optional(),
    xai: loginStateSchema.optional(),
    'opencode-go': loginStateSchema.optional(),
    'github-copilot': loginStateSchema.optional(),
    poe: loginStateSchema.optional(),
    minimax: loginStateSchema.optional(),
    kimi: loginStateSchema.optional(),
    zai: loginStateSchema.optional(),
    alibaba: loginStateSchema.optional(),
  })
  .describe('Background login attempts, one per provider')

export const configFileSchema = z
  .object({
    $schema: z.string().optional().describe('JSON Schema URL for editor autocomplete'),
    version: z.literal(1),
    providers: providersSchema,
    presets: z
      .record(z.string(), z.array(z.string()).describe('Ranked provider/model entries such as anthropic/claude-opus-4-6'))
      .describe('Named presets. Each value is the failover order for that preset'),
    cooldowns: z
      .record(z.string(), z.number())
      .describe('Map of provider:accountKey to epoch milliseconds until the account is usable again'),
    routes: z
      .record(
        z.string(),
        z
          .object({
            preset: z.string().describe('Subrouter preset that selected this route'),
            provider: providerIdSchema,
            modelId: z.string().describe('Underlying model id for the in-flight route'),
          })
          .describe('In-flight provider/model for one harness session'),
      )
      .describe('Map of session id to the live route until that session goes idle'),
    logins: loginsSchema,
  })
  .describe('~/.subrouter/config.json')

export type StoredAccount = z.infer<typeof storedAccountSchema>
export type ProviderAccounts = z.infer<typeof providerAccountsSchema>
export type LoginState = z.infer<typeof loginStateSchema>
export type ConfigFile = z.infer<typeof configFileSchema>
export type AccountsFile = { version: 1; providers: ConfigFile['providers'] }
export type PresetsFile = { version: 1; presets: ConfigFile['presets'] }
export type StateFile = { version: 1; cooldowns: ConfigFile['cooldowns'] }

export const configJsonSchema = z.toJSONSchema(configFileSchema, {
  target: 'draft-7',
  io: 'input',
  unrepresentable: 'any',
})
