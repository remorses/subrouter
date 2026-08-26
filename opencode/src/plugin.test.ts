import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { PluginInput } from '@opencode-ai/plugin'
import { loadAccounts, PROVIDER_IDS } from '@subrouter/cli'
import { subrouterAuthPlugin, subrouterPlugin } from './index.ts'

let home: string
const openServers: Server[] = []

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'subrouter-plugin-'))
  process.env.SUBROUTER_HOME = home
})

afterEach(async () => {
  delete process.env.SUBROUTER_HOME
  delete process.env.SUBROUTER_OPENAI_ISSUER_URL
  for (const server of openServers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  }
  await rm(home, { recursive: true, force: true })
})

/** Minimal stand-in for the OpenAI Codex device endpoints. */
async function startFakeOpenAIIssuer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url || '', 'http://localhost')
    const send = (body: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/api/accounts/deviceauth/usercode') {
      return send({ device_auth_id: 'dev-1', user_code: 'ABCD-9876', interval: '0' })
    }
    if (url.pathname === '/api/accounts/deviceauth/token') {
      return send({ authorization_code: 'auth-code', code_verifier: 'verifier' })
    }
    if (url.pathname === '/oauth/token') {
      const claims = Buffer.from(
        JSON.stringify({ email: 'pool@example.com', chatgpt_account_id: 'acct-9' }),
      ).toString('base64url')
      return send({
        access_token: 'access-9',
        refresh_token: 'refresh-9',
        expires_in: 3600,
        id_token: `header.${claims}.signature`,
      })
    }
    res.writeHead(404).end('{}')
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (typeof address === 'string' || !address) throw new Error('failed to bind fake issuer')
  openServers.push(server)
  return `http://127.0.0.1:${address.port}`
}

function authMethod() {
  return subrouterAuthPlugin({} as PluginInput).then((hooks) => {
    const method = hooks.auth?.methods[0]
    if (!method || method.type !== 'oauth') throw new Error('expected an oauth method')
    return { provider: hooks.auth!.provider, method }
  })
}

test('config hook registers the subrouter provider with preset models', async () => {
  await writeFile(
    path.join(home, 'presets.json'),
    JSON.stringify({ version: 1, presets: { work: ['anthropic/claude-opus-4-6'] } }),
  )

  const hooks = await subrouterPlugin({} as PluginInput)
  const config: Record<string, any> = {}
  await hooks.config?.(config as any)

  const provider = config.provider?.subrouter
  expect(provider).toBeTruthy()
  expect(provider.npm.startsWith('file://')).toBe(true)
  expect(provider.npm.endsWith('provider.ts') || provider.npm.endsWith('provider.js')).toBe(true)
  expect(Object.keys(provider.models).sort()).toEqual(['default', 'work'])
  expect(provider.models.default.cost).toEqual({ input: 0, output: 0, cache_read: 0, cache_write: 0 })
})

test('auth hook asks which subscription to add before authorizing', async () => {
  const { provider, method } = await authMethod()

  expect(provider).toBe('subrouter')
  const prompt = method.prompts?.[0]
  expect(prompt?.type).toBe('select')
  expect(prompt?.key).toBe('provider')
  expect(prompt?.type === 'select' && prompt.options.map((o) => o.value)).toEqual([...PROVIDER_IDS])
  const methodPrompt = method.prompts?.[1]
  expect(methodPrompt?.type).toBe('select')
  expect(methodPrompt?.key).toBe('method')
  expect(methodPrompt?.type === 'select' && methodPrompt.options.map((o) => o.value)).toEqual([
    'browser',
    'device',
  ])
})

test('authorize rejects a missing or unknown subscription', async () => {
  const { method } = await authMethod()

  await expect(method.authorize({})).rejects.toThrow(/Pick a subscription/)
  await expect(method.authorize({ provider: 'nope' })).rejects.toThrow(/Pick a subscription/)
})

test('authorize dispatches to the chosen adapter and the callback pools the account', async () => {
  process.env.SUBROUTER_OPENAI_ISSUER_URL = await startFakeOpenAIIssuer()
  const { method } = await authMethod()

  const result = await method.authorize({ provider: 'openai', method: 'device' })
  expect(result.method).toBe('auto')
  expect(result.instructions).toMatch(/code:\s*ABCD-9876/)

  if (result.method !== 'auto') throw new Error('expected the device flow')
  const credentials = await result.callback()

  expect(credentials).toMatchObject({ type: 'success', access: 'access-9', refresh: 'refresh-9' })
  const accounts = await loadAccounts()
  expect(accounts.providers.openai?.accounts).toMatchObject([
    { type: 'oauth', email: 'pool@example.com', accountId: 'acct-9' },
  ])
})

test('opencode zen asks for a pasted key and stores it as an api account', async () => {
  const { method } = await authMethod()

  const result = await method.authorize({ provider: 'opencode' })
  expect(result.method).toBe('code')

  if (result.method !== 'code') throw new Error('expected a pasted-key flow')
  expect(await result.callback('zen-key-1')).toMatchObject({ type: 'success', key: 'zen-key-1' })

  const accounts = await loadAccounts()
  expect(accounts.providers.opencode?.accounts).toMatchObject([{ type: 'api', key: 'zen-key-1' }])
})

test('a failed login reports failure instead of pooling a broken account', async () => {
  const { method } = await authMethod()

  const result = await method.authorize({ provider: 'opencode' })
  if (result.method !== 'code') throw new Error('expected a pasted-key flow')

  expect(await result.callback('   ')).toEqual({ type: 'failed' })
  const accounts = await loadAccounts()
  expect(accounts.providers.opencode).toBeUndefined()
})
