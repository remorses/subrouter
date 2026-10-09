import childProcess from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import util from 'node:util'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  addAccount,
  adapters,
  loadAccounts,
  OPENAI_WEBSOCKET_SESSION_HEADER,
  OPENAI_WEBSOCKET_TITLE_HEADER,
  PROVIDER_DISPLAY_NAME,
  PROVIDER_ID,
  savePreset,
  setLiveRoute,
} from '@subrouter/cli'
import plugin, { authorizeSubrouterLogin, oauthProviderIds } from './index.ts'
import {
  addSubrouterHeaders,
  loadPresetCatalog,
  revealRoutedModel,
  rewritePoweredByModelLine,
} from './provider.ts'

const execFile = util.promisify(childProcess.execFile)
let home: string
const openServers: Server[] = []

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'subrouter-plugin-'))
  process.env.SUBROUTER_HOME = home
  process.env.SUBROUTER_MODELS_DEV_URL = await startFakeModelsDev()
})

afterEach(async () => {
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
          attachment?: boolean
          reasoning?: boolean
          temperature?: boolean
          tool_call?: boolean
          modalities?: { input?: string[]; output?: string[] }
          limit?: { context?: number; output?: number; input?: number }
          reasoning_options?: Array<{ type: string; values?: Array<string | null> }>
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

async function startFakeOpenAIIssuer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url || '', 'http://localhost')
    const send = (body: object) => {
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

test('plugin load does not write stdout or stderr', async () => {
  const script =
    "import('./src/index.ts').then((mod) => { if (mod.default?.id !== 'subrouter') throw new Error('missing v2 plugin') })"
  const result = await execFile(process.execPath, ['--no-warnings', '--import', 'tsx', '--eval', script], {
    cwd: process.cwd(),
    env: process.env,
  })
  expect(result).toEqual({ stdout: '', stderr: '' })
})

test('default export is a v2 Plugin.define definition', () => {
  expect(plugin).toMatchObject({ id: 'subrouter' })
  expect(typeof plugin.setup).toBe('function')
})

test('catalog registers preset models on the subrouter provider', async () => {
  await savePreset({ name: 'work', models: ['anthropic/claude-opus-4-6'] })
  const catalog = await loadPresetCatalog()
  expect(catalog.provider.name).toBe(PROVIDER_DISPLAY_NAME)
  expect(catalog.provider.package.startsWith('aisdk:file://')).toBe(true)
  expect(catalog.provider.package.endsWith('provider.ts') || catalog.provider.package.endsWith('provider.js')).toBe(
    true,
  )
  expect(Object.keys(catalog.models).sort()).toEqual(['default', 'work'])
  expect(catalog.models.default?.name).toBe('default')
  expect(catalog.models.work?.name).toBe('work')
  expect(catalog.models.default?.limit).toEqual({ context: 200_000, output: 64_000 })
  expect(catalog.models.work?.limit).toEqual({ context: 200_000, output: 64_000 })
})

test('preset model names stay stable when the routed candidate changes', async () => {
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
  const catalog = await loadPresetCatalog()
  expect(catalog.provider.name).toBe(PROVIDER_DISPLAY_NAME)
  expect(catalog.models.work?.name).toBe('work')
})

test('preset model limits follow the first live candidate', async () => {
  const modelId = adapters.anthropic.defaultModels[0]
  if (!modelId) throw new Error('anthropic adapter has no default model')
  process.env.SUBROUTER_MODELS_DEV_URL = await startFakeModelsDev({
    anthropic: {
      models: {
        [modelId]: {
          id: modelId,
          modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
          limit: { context: 1_000_000, input: 900_000, output: 128_000 },
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
  const catalog = await loadPresetCatalog()
  expect(catalog.models.work?.limit).toEqual({
    context: 1_000_000,
    input: 900_000,
    output: 128_000,
  })
})

test('preset reasoning follows the first live candidate', async () => {
  const modelId = adapters.openai.defaultModels[0]
  if (!modelId) throw new Error('openai adapter has no default model')
  process.env.SUBROUTER_MODELS_DEV_URL = await startFakeModelsDev({
    openai: {
      models: {
        [modelId]: {
          id: modelId,
          reasoning: true,
          modalities: { input: ['text'], output: ['text'] },
          limit: { context: 200_000, output: 64_000 },
        },
      },
    },
  })
  await addAccount({
    provider: 'openai',
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
  await savePreset({ name: 'work', models: [`openai/${modelId}`] })
  const catalog = await loadPresetCatalog()
  expect(catalog.models.work?.reasoning).toBe(true)
})

test('preset variants follow the first live candidate', async () => {
  const modelId = adapters.openai.defaultModels[0]
  if (!modelId) throw new Error('openai adapter has no default model')
  process.env.SUBROUTER_MODELS_DEV_URL = await startFakeModelsDev({
    openai: {
      models: {
        [modelId]: {
          id: modelId,
          reasoning: true,
          modalities: { input: ['text'], output: ['text'] },
          reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high'] }],
        },
      },
    },
  })
  await addAccount({
    provider: 'openai',
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
  await savePreset({ name: 'work', models: [`openai/${modelId}#high`] })
  const catalog = await loadPresetCatalog()
  expect(catalog.models.work?.variants).toEqual([
    { id: 'none', settings: { reasoningEffort: 'none', reasoningSummary: 'auto' } },
    { id: 'low', settings: { reasoningEffort: 'low', reasoningSummary: 'auto' } },
    { id: 'medium', settings: { reasoningEffort: 'medium', reasoningSummary: 'auto' } },
    { id: 'high', settings: { reasoningEffort: 'high', reasoningSummary: 'auto' } },
  ])
})

test('preset model input modalities are the union of usable candidates', async () => {
  process.env.SUBROUTER_MODELS_DEV_URL = await startFakeModelsDev({
    openai: {
      models: {
        'gpt-pdf': {
          id: 'gpt-pdf',
          attachment: true,
          modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        },
      },
    },
    'kimi-for-coding': {
      models: {
        'kimi-image': {
          id: 'kimi-image',
          attachment: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
        },
      },
    },
  })
  await addAccount({
    provider: 'openai',
    account: {
      type: 'oauth',
      access: 'access-1',
      refresh: 'refresh-1',
      expires: Date.now() + 60_000,
      addedAt: 1,
      lastUsed: 1,
    },
  })
  await addAccount({
    provider: 'kimi',
    account: { type: 'api', key: 'kimi-key', addedAt: 1, lastUsed: 1 },
  })
  await savePreset({ name: 'work', models: ['openai/gpt-pdf', 'kimi/kimi-image'] })
  const catalog = await loadPresetCatalog()
  expect(catalog.models.work?.capabilities).toEqual({
    tools: true,
    input: ['text', 'image', 'pdf'],
    output: ['text'],
  })
})

test('xAI presets do not advertise inline PDF support that its SDK cannot encode', async () => {
  process.env.SUBROUTER_MODELS_DEV_URL = await startFakeModelsDev({
    xai: {
      models: {
        'grok-pdf': {
          id: 'grok-pdf',
          attachment: true,
          modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        },
      },
    },
  })
  await addAccount({
    provider: 'xai',
    account: {
      type: 'oauth',
      access: 'access-1',
      refresh: 'refresh-1',
      expires: Date.now() + 60_000,
      addedAt: 1,
      lastUsed: 1,
    },
  })
  await savePreset({ name: 'work', models: ['xai/grok-pdf'] })
  const catalog = await loadPresetCatalog()
  expect(catalog.models.work?.capabilities).toEqual({
    tools: true,
    input: ['text', 'image'],
    output: ['text'],
  })
})

test('Anthropic-compatible coding plans do not advertise video input', async () => {
  process.env.SUBROUTER_MODELS_DEV_URL = await startFakeModelsDev({
    'kimi-for-coding': {
      models: {
        'kimi-video': {
          id: 'kimi-video',
          attachment: true,
          modalities: { input: ['text', 'image', 'video'], output: ['text'] },
        },
      },
    },
  })
  await addAccount({
    provider: 'kimi',
    account: { type: 'api', key: 'kimi-key', addedAt: 1, lastUsed: 1 },
  })
  await savePreset({ name: 'work', models: ['kimi/kimi-video'] })
  const catalog = await loadPresetCatalog()
  expect(catalog.models.work?.capabilities).toEqual({
    tools: true,
    input: ['text', 'image'],
    output: ['text'],
  })
})

test('preset ids stay stable when presets share a routed model', async () => {
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
  await addAccount({
    provider: 'openai',
    account: {
      type: 'oauth',
      refresh: 'refresh-o',
      access: 'access-o',
      expires: Date.now() + 60_000,
      email: 'o@x.com',
      addedAt: 1,
      lastUsed: 1,
    },
  })
  await savePreset({ name: 'default', models: ['anthropic/claude-opus-4-6'] })
  await savePreset({ name: 'openai-only', models: ['openai/gpt-5.5'] })
  await savePreset({ name: 'codex-b', models: ['openai/gpt-5.5'] })
  const catalog = await loadPresetCatalog()
  expect(catalog.models['openai-only']?.name).toBe('openai-only')
  expect(catalog.models['codex-b']?.name).toBe('codex-b')
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

test('system transform uses the in-flight session route, not the first free preset model', async () => {
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
  await addAccount({
    provider: 'opencode-go',
    account: { type: 'api', key: 'zen-key', addedAt: 1, lastUsed: 1 },
  })
  await savePreset({
    name: 'default',
    models: ['anthropic/claude-fake', 'opencode-go/fake-model'],
  })
  await setLiveRoute({
    sessionID: 'ses_1',
    preset: 'default',
    provider: 'opencode-go',
    modelId: 'fake-model',
  })
  const system = ['You are powered by the model named default. The exact model ID is subrouter/default']
  await revealRoutedModel({
    providerID: PROVIDER_ID,
    preset: 'default',
    sessionID: 'ses_1',
    system,
  })
  expect(system[0]).toContain('You are powered by the model named fake-model.')
  expect(system[0]).toContain('The exact model ID is opencode-go/fake-model')
  expect(system[0]).not.toContain('claude-fake')
})

test('system transform reveals a live GPT route', async () => {
  await addAccount({
    provider: 'openai',
    account: {
      type: 'oauth',
      refresh: 'refresh-o',
      access: 'access-o',
      expires: Date.now() + 60_000,
      email: 'o@x.com',
      addedAt: 1,
      lastUsed: 1,
    },
  })
  await savePreset({ name: 'openai-only', models: ['openai/gpt-5.5'] })
  await setLiveRoute({
    sessionID: 'ses_gpt',
    preset: 'openai-only',
    provider: 'openai',
    modelId: 'gpt-5.5',
  })
  const system = [
    'You are powered by the model named openai-only. The exact model ID is subrouter/openai-only',
  ]
  await revealRoutedModel({
    providerID: PROVIDER_ID,
    preset: 'openai-only',
    sessionID: 'ses_gpt',
    system,
  })
  expect(system[0]).toContain('You are powered by the model named gpt-5.5.')
  expect(system).toHaveLength(1)
})

test('primary model.request headers pin session affinity and skip title requests', () => {
  const primary = { headers: {} satisfies Record<string, string> }
  addSubrouterHeaders({
    sessionID: 'session-1',
    agent: 'build',
    kind: 'primary',
    model: { providerID: 'subrouter', id: 'default', variant: 'high' },
    headers: primary.headers,
  })
  expect(primary.headers).toMatchObject({
    'x-subrouter-route-affinity': 'session-1',
    'x-subrouter-opencode-agent': 'build',
    'x-subrouter-opencode-variant': 'high',
    [OPENAI_WEBSOCKET_SESSION_HEADER]: 'session-1',
  })

  const title = { headers: {} satisfies Record<string, string> }
  addSubrouterHeaders({
    sessionID: 'session-1',
    agent: 'title',
    kind: 'title',
    model: { providerID: 'subrouter', id: 'default', variant: 'high' },
    headers: title.headers,
  })
  expect(title.headers['x-subrouter-route-affinity']).toBeUndefined()
  expect(title.headers[OPENAI_WEBSOCKET_TITLE_HEADER]).toBe('true')
})

test('OpenCode login exposes only OAuth-capable providers', () => {
  expect(oauthProviderIds).toEqual(['anthropic', 'openai', 'xai', 'github-copilot', 'poe'])
})

test('authorize rejects a missing or unknown subscription', async () => {
  await expect(authorizeSubrouterLogin({})).rejects.toThrow(/Pick a subscription/)
  await expect(authorizeSubrouterLogin({ provider: 'nope' })).rejects.toThrow(/Pick a subscription/)
  await expect(authorizeSubrouterLogin({ provider: 'opencode-go' })).rejects.toThrow(/OpenCode login/)
})

test('authorize dispatches to the chosen adapter and returns Credential.OAuth', async () => {
  process.env.SUBROUTER_OPENAI_ISSUER_URL = await startFakeOpenAIIssuer()
  const result = await authorizeSubrouterLogin({ provider: 'openai', method: 'device' })
  expect(result.mode).toBe('auto')
  expect(result.instructions).toMatch(/code:\s*ABCD-9876/)
  if (result.mode !== 'auto') throw new Error('expected the device flow')
  const credentials = await result.callback
  expect(credentials).toMatchObject({
    type: 'oauth',
    methodID: 'login',
    access: 'access-9',
    refresh: 'refresh-9',
  })
  const accounts = await loadAccounts()
  expect(accounts.providers.openai?.accounts).toMatchObject([
    { type: 'oauth', email: 'pool@example.com', accountId: 'acct-9' },
  ])
})
