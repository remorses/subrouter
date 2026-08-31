import childProcess from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import util from 'node:util'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { Config, PluginInput } from '@opencode-ai/plugin'
import { createOpencodeClient } from '@opencode-ai/sdk'
import {
  addAccount,
  adapters,
  loadAccounts,
  PROVIDER_DISPLAY_NAME,
  PROVIDER_IDS,
  savePreset,
} from '@subrouter/cli'
import { subrouterAuthPlugin, subrouterPlugin } from './index.ts'
import { revealRoutedModel, rewritePoweredByModelLine } from './provider.ts'

const execFile = util.promisify(childProcess.execFile)
let home: string
const openServers: Server[] = []
const pluginInput = {} as PluginInput

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'subrouter-plugin-'))
  process.env.SUBROUTER_HOME = home
  process.env.SUBROUTER_MODELS_DEV_URL = await startFakeModelsDev()
})

afterEach(async () => {
  delete process.env.SUBROUTER_HOME
  delete process.env.SUBROUTER_OPENAI_ISSUER_URL
  delete process.env.SUBROUTER_MODELS_DEV_URL
  for (const server of openServers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  }
  await rm(home, { recursive: true, force: true })
})

async function startFakeModelsDev(
  providers: Record<
    string,
    {
      models: Record<
        string,
        {
          id: string
          modalities?: { output?: string[] }
          limit?: { context?: number; output?: number; input?: number }
        }
      >
    }
  > = {},
) {
  const payload = {
    anthropic: { models: {} },
    openai: { models: {} },
    xai: { models: {} },
    'opencode-go': { models: {} },
    'github-copilot': { models: {} },
    poe: { models: {} },
    'minimax-coding-plan': { models: {} },
    'kimi-for-coding': { models: {} },
    'zai-coding-plan': { models: {} },
    'alibaba-coding-plan': { models: {} },
    ...providers,
  }
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(payload))
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (typeof address === 'string' || !address) throw new Error('failed to bind fake models.dev')
  openServers.push(server)
  return `http://127.0.0.1:${address.port}`
}

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
  return subrouterAuthPlugin(pluginInput).then((hooks) => {
    const method = hooks.auth?.methods[0]
    if (!method || method.type !== 'oauth') throw new Error('expected an oauth method')
    return { provider: hooks.auth!.provider, method }
  })
}

test('plugin load and config do not write stdout or stderr', async () => {
  const script = "import('./src/index.ts').then(async ({ subrouterPlugin }) => { const hooks = await subrouterPlugin({}); await hooks.config?.({}) })"
  const result = await execFile(path.resolve('../node_modules/.bin/tsx'), ['--eval', script], {
    cwd: process.cwd(),
    env: process.env,
  })
  expect(result).toEqual({ stdout: '', stderr: '' })
})

test('provider log callback forwards only to client.app.log', async () => {
  const received = Promise.withResolvers<object>()
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    req.on('end', () => {
      received.resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as object)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  openServers.push(server)
  const address = server.address()
  if (typeof address === 'string' || !address) throw new Error('failed to bind log server')
  const client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${address.port}` })
  const hooks = await subrouterPlugin({ ...pluginInput, client })
  const config: Config = {}
  await hooks.config?.(config)
  const log = config.provider?.subrouter?.options?.log
  expect(log).toBeTypeOf('function')
  if (typeof log !== 'function') throw new Error('expected provider log callback')
  await log({
    level: 'warn',
    message: 'failover openai/gpt-5.5',
    extra: { provider: 'openai', modelId: 'gpt-5.5' },
  })
  expect(await received.promise).toEqual({
    service: 'subrouter',
    level: 'warn',
    message: 'failover openai/gpt-5.5',
    extra: { provider: 'openai', modelId: 'gpt-5.5' },
  })
})

test('config hook registers the subrouter provider with preset models', async () => {
  await savePreset({ name: 'work', models: ['anthropic/claude-opus-4-6'] })

  const hooks = await subrouterPlugin(pluginInput)
  const config: Record<string, any> = {}
  await hooks.config?.(config as any)

  const provider = config.provider?.subrouter
  expect(provider).toBeTruthy()
  expect(provider.name).toBe(PROVIDER_DISPLAY_NAME)
  expect(provider.npm.startsWith('file://')).toBe(true)
  expect(provider.npm.endsWith('provider.ts') || provider.npm.endsWith('provider.js')).toBe(true)
  expect(Object.keys(provider.models).sort()).toEqual(['default', 'work'])
  expect(provider.models.default.name).toBe('default')
  expect(provider.models.work.name).toBe('work')
  expect(provider.models.default.cost).toEqual({ input: 0, output: 0, cache_read: 0, cache_write: 0 })
  expect(provider.models.default.limit).toEqual({ context: 200_000, output: 64_000 })
  expect(provider.models.work.limit).toEqual({ context: 200_000, output: 64_000 })
})

test('preset model names show the first live candidate', async () => {
  await addAccount({
    provider: 'anthropic',
    account: {
      type: 'oauth',
      refresh: 'refresh-1',
      access: 'access-1',
      expires: Date.now() + 60_000,
      email: 'a@x.com',
      addedAt: 1,
      lastUsed: 1,
    },
  })
  await savePreset({ name: 'work', models: ['anthropic/claude-opus-4-6'] })

  const hooks = await subrouterPlugin(pluginInput)
  const config: Config = {}
  await hooks.config?.(config)

  expect(config.provider?.subrouter?.name).toBe(PROVIDER_DISPLAY_NAME)
  expect(config.provider?.subrouter?.models?.work?.name).toBe('work (claude-opus-4-6)')
})

test('preset model limits follow the first live candidate', async () => {
  const modelId = adapters.anthropic.defaultModels[0]
  if (!modelId) throw new Error('anthropic adapter has no default model')
  process.env.SUBROUTER_MODELS_DEV_URL = await startFakeModelsDev({
    anthropic: {
      models: {
        [modelId]: {
          id: modelId,
          modalities: { output: ['text'] },
          limit: { context: 1_000_000, output: 128_000 },
        },
      },
    },
  })
  await addAccount({
    provider: 'anthropic',
    account: {
      type: 'oauth',
      refresh: 'refresh-1',
      access: 'access-1',
      expires: Date.now() + 60_000,
      email: 'a@x.com',
      addedAt: 1,
      lastUsed: 1,
    },
  })
  await savePreset({ name: 'work', models: [`anthropic/${modelId}`] })

  const hooks = await subrouterPlugin(pluginInput)
  const config: Config = {}
  await hooks.config?.(config)

  expect(config.provider?.subrouter?.models?.work?.limit).toEqual({
    context: 1_000_000,
    output: 128_000,
  })
  expect(config.provider?.subrouter?.models?.default?.limit).toEqual({
    context: 1_000_000,
    output: 128_000,
  })
})

test('preset models permit image and PDF attachments', async () => {
  const hooks = await subrouterPlugin(pluginInput)
  const config: Config = {}
  await hooks.config?.(config)

  expect(config.provider?.subrouter?.models?.default).toMatchObject({
    attachment: true,
    modalities: {
      input: ['text', 'image', 'pdf'],
      output: ['text'],
    },
  })
})

test('rewrites the OpenCode powered-by line to the routed candidate', () => {
  const system = [
    'You are powered by the model named build. The exact model ID is subrouter/build\n<env>\n  Working directory: /tmp\n</env>',
  ]
  rewritePoweredByModelLine({
    system,
    candidate: { provider: 'anthropic', modelId: 'claude-opus-4-6' },
  })
  expect(system[0]).toContain('You are powered by the model named claude-opus-4-6.')
  expect(system[0]).toContain('The exact model ID is anthropic/claude-opus-4-6')
  expect(system[0]).not.toContain('subrouter/build')
})

test('system transform rewrites the powered-by line to the live candidate', async () => {
  await addAccount({
    provider: 'anthropic',
    account: {
      type: 'oauth',
      refresh: 'refresh-1',
      access: 'access-1',
      expires: Date.now() + 60_000,
      email: 'a@x.com',
      addedAt: 1,
      lastUsed: 1,
    },
  })

  const system = [
    'You are powered by the model named build. The exact model ID is subrouter/build\n<env>\n  Working directory: /tmp\n</env>',
  ]
  await revealRoutedModel({ providerID: 'subrouter', preset: 'default', system })

  const modelId = adapters.anthropic.defaultModels[0]
  expect(system[0]).toContain(`You are powered by the model named ${modelId}.`)
  expect(system[0]).toContain(`The exact model ID is anthropic/${modelId}`)
  expect(system[0]).not.toContain('subrouter/build')
})

test('system transform leaves other providers unchanged', async () => {
  const original =
    'You are powered by the model named claude-opus-4-6. The exact model ID is anthropic/claude-opus-4-6'
  const system = [original]
  await revealRoutedModel({ providerID: 'anthropic', preset: 'claude-opus-4-6', system })
  expect(system[0]).toBe(original)
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

test('opencode go asks for a pasted key and stores it as an api account', async () => {
  const { method } = await authMethod()

  const result = await method.authorize({ provider: 'opencode-go' })
  expect(result.method).toBe('code')

  if (result.method !== 'code') throw new Error('expected a pasted-key flow')
  expect(await result.callback('go-key-1')).toMatchObject({ type: 'success', key: 'go-key-1' })

  const accounts = await loadAccounts()
  expect(accounts.providers['opencode-go']?.accounts).toMatchObject([{ type: 'api', key: 'go-key-1' }])
})

test('a failed login reports failure instead of pooling a broken account', async () => {
  const { method } = await authMethod()

  const result = await method.authorize({ provider: 'opencode-go' })
  if (result.method !== 'code') throw new Error('expected a pasted-key flow')

  expect(await result.callback('   ')).toEqual({ type: 'failed' })
  const accounts = await loadAccounts()
  expect(accounts.providers['opencode-go']).toBeUndefined()
})
