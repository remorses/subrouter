/**
 * Router failover tests with fake provider HTTP servers. No real API calls:
 * the anthropic mock returns rate-limit errors, the opencode-go (OpenAI
 * compatible) mock returns canned completions, and we assert the router
 * cycles accounts and providers in order, recording cooldowns.
 */

import { createServer, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { APICallError, type LanguageModelV3CallOptions } from '@ai-sdk/provider'
import {
  AllCandidatesExhaustedError,
  createSubrouter,
  filterPresetModelsByInput,
  NoUsableAccountError,
  requiredInputModalities,
  resolveActiveCandidate,
  resolveCandidates,
  RouterModel,
} from './router.ts'
import { parseModelsDevCatalog, type SubrouterLogEntry } from './adapters/index.ts'
import { addAccount, loadState, markCooldown, savePreset, type StoredAccount } from './store.ts'

type MockResponse = { status: number; headers?: Record<string, string>; body: string }

type MockServer = {
  url: string
  requests: { path: string; authorization: string | undefined; body: string }[]
  close: () => Promise<void>
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    },
  }
}

async function startMockServer(respond: (request: { path: string }) => MockResponse): Promise<MockServer> {
  const requests: MockServer['requests'] = []
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += String(chunk)
    })
    req.on('end', () => {
      requests.push({
        path: req.url ?? '',
        authorization: req.headers.authorization,
        body,
      })
      const response = respond({ path: req.url ?? '' })
      res.writeHead(response.status, { 'content-type': 'application/json', ...response.headers })
      res.end(response.body)
    })
  })
  const listening = await listen(server)
  return { ...listening, requests }
}

async function startChatSseServer({
  writeBody,
}: {
  writeBody: (res: ServerResponse) => void
}): Promise<MockServer> {
  const requests: MockServer['requests'] = []
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += String(chunk)
    })
    req.on('end', () => {
      requests.push({
        path: req.url ?? '',
        authorization: req.headers.authorization,
        body,
      })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.flushHeaders()
      writeBody(res)
    })
  })
  const listening = await listen(server)
  return { ...listening, requests }
}

const anthropic429: MockResponse = {
  status: 429,
  body: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }),
}

const anthropic400: MockResponse = {
  status: 400,
  body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad request' } }),
}

const chatCompletionOk = (text: string): MockResponse => ({
  status: 200,
  body: JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model: 'fake-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  }),
})

function oauthAccount(overrides: Partial<StoredAccount> = {}): StoredAccount {
  return {
    type: 'oauth',
    refresh: 'refresh-1',
    access: 'access-1',
    expires: Date.now() + 1_000_000_000,
    addedAt: 1000,
    lastUsed: 1000,
    ...overrides,
  }
}

const callOptions: LanguageModelV3CallOptions = {
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
}

let home: string
let servers: MockServer[] = []

test('PDF calls keep only preset models that can encode PDF input', () => {
  const emptyProvider = { models: {} }
  const model = (input: string[]) => ({
    id: 'model',
    attachment: true,
    modalities: { input, output: ['text'] },
  })
  const catalog = parseModelsDevCatalog({
    anthropic: emptyProvider,
    openai: { models: { model: model(['text', 'image', 'pdf']) } },
    xai: { models: { model: model(['text', 'image', 'pdf']) } },
    'opencode-go': emptyProvider,
    'github-copilot': emptyProvider,
    poe: emptyProvider,
    'minimax-coding-plan': emptyProvider,
    'kimi-for-coding': { models: { model: model(['text', 'image']) } },
    'zai-coding-plan': emptyProvider,
    'alibaba-coding-plan': emptyProvider,
  })
  if (catalog instanceof Error) throw catalog
  const required = requiredInputModalities({
    prompt: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'read this' },
          {
            type: 'file',
            filename: 'document.pdf',
            mediaType: 'application/pdf',
            data: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
          },
        ],
      },
    ],
  })

  expect(
    filterPresetModelsByInput({
      presetModels: ['openai/model', 'xai/model', 'kimi/model'],
      required,
      catalog,
    }),
  ).toEqual({
    presetModels: ['openai/model'],
    skipped: [
      'xai/model: does not support pdf input',
      'kimi/model: does not support pdf input',
    ],
  })
})

test('video calls skip Anthropic-compatible coding plans', () => {
  const emptyProvider = { models: {} }
  const videoModel = {
    id: 'model',
    attachment: true,
    modalities: { input: ['text', 'image', 'video'], output: ['text'] },
  }
  const catalog = parseModelsDevCatalog({
    anthropic: emptyProvider,
    openai: emptyProvider,
    xai: emptyProvider,
    'opencode-go': emptyProvider,
    'github-copilot': emptyProvider,
    poe: emptyProvider,
    'minimax-coding-plan': { models: { model: videoModel } },
    'kimi-for-coding': { models: { model: videoModel } },
    'zai-coding-plan': emptyProvider,
    'alibaba-coding-plan': emptyProvider,
  })
  if (catalog instanceof Error) throw catalog

  expect(
    filterPresetModelsByInput({
      presetModels: ['minimax/model', 'kimi/model'],
      required: new Set(['text', 'video'] as const),
      catalog,
    }),
  ).toEqual({
    presetModels: [],
    skipped: [
      'minimax/model: does not support video input',
      'kimi/model: does not support video input',
    ],
  })
})

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'subrouter-router-'))
  process.env.SUBROUTER_HOME = home
})

afterEach(async () => {
  delete process.env.SUBROUTER_HOME
  delete process.env.SUBROUTER_ANTHROPIC_BASE_URL
  delete process.env.SUBROUTER_MODELS_DEV_URL
  delete process.env.SUBROUTER_OPENCODE_GO_BASE_URL
  for (const server of servers) await server.close()
  servers = []
  await rm(home, { recursive: true, force: true })
})

describe('RouterModel failover', () => {
  test('cycles anthropic accounts then falls through to next provider', async () => {
    const anthropicMock = await startMockServer(() => anthropic429)
    const opencodeMock = await startMockServer(() => chatCompletionOk('hello from fallback'))
    servers = [anthropicMock, opencodeMock]
    process.env.SUBROUTER_ANTHROPIC_BASE_URL = `${anthropicMock.url}/v1`
    process.env.SUBROUTER_OPENCODE_GO_BASE_URL = `${opencodeMock.url}/v1`

    await addAccount({ provider: 'anthropic', account: oauthAccount({ email: 'a@x.com', refresh: 'r1', access: 'acc1' }) })
    await addAccount({ provider: 'anthropic', account: oauthAccount({ email: 'b@x.com', refresh: 'r2', access: 'acc2' }) })
    await addAccount({
      provider: 'opencode-go',
      account: { type: 'api', key: 'zen-key', addedAt: 1, lastUsed: 1 },
    })
    await savePreset({ name: 'test', models: ['anthropic/claude-fake', 'opencode-go/fake-model'] })

    const events: string[] = []
    const model = new RouterModel({
      preset: 'test',
      onEvent: (event) => {
        if (event.type === 'trying') events.push(`trying ${event.candidate.provider}`)
        if (event.type === 'failover') events.push(`failover ${event.candidate.provider}`)
      },
    })
    const result = await model.doGenerate(callOptions)
    const texts = result.content.filter((part) => part.type === 'text').map((part) => part.text)
    expect(texts).toEqual(['hello from fallback'])

    // Both anthropic accounts were tried, then opencode-go
    expect(events).toMatchInlineSnapshot(`
      [
        "trying anthropic",
        "failover anthropic",
        "trying anthropic",
        "failover anthropic",
        "trying opencode-go",
      ]
    `)
    expect(anthropicMock.requests.length).toBe(2)
    expect(anthropicMock.requests.map((r) => r.authorization)).toEqual(['Bearer acc2', 'Bearer acc1'])
    expect(opencodeMock.requests[0]!.authorization).toBe('Bearer zen-key')

    // Both anthropic accounts are now cooling down globally
    const state = await loadState()
    expect(Object.keys(state.cooldowns).sort()).toEqual(['anthropic:a@x.com', 'anthropic:b@x.com'])
  })

  test('logs trying and failover through the harness callback', async () => {
    const anthropicMock = await startMockServer(() => anthropic429)
    const opencodeMock = await startMockServer(() => chatCompletionOk('hello from fallback'))
    servers = [anthropicMock, opencodeMock]
    process.env.SUBROUTER_ANTHROPIC_BASE_URL = `${anthropicMock.url}/v1`
    process.env.SUBROUTER_OPENCODE_GO_BASE_URL = `${opencodeMock.url}/v1`

    await addAccount({ provider: 'anthropic', account: oauthAccount({ email: 'a@x.com', refresh: 'r1', access: 'acc1' }) })
    await addAccount({
      provider: 'opencode-go',
      account: { type: 'api', key: 'zen-key', addedAt: 1, lastUsed: 1 },
    })
    await savePreset({ name: 'test', models: ['anthropic/claude-fake', 'opencode-go/fake-model'] })

    const logs: SubrouterLogEntry[] = []
    const model = new RouterModel({
      preset: 'test',
      log: (entry) => {
        logs.push(entry)
      },
    })
    await model.doGenerate(callOptions)
    expect(logs.map((entry) => `${entry.level} ${entry.message}`)).toMatchInlineSnapshot(`
      [
        "info trying anthropic/claude-fake #1 (a@x.com)",
        "warn failover anthropic/claude-fake #1 (a@x.com)",
        "info trying opencode-go/fake-model #1 (API key)",
      ]
    `)
    expect(logs[1]?.extra).toMatchObject({
      provider: 'anthropic',
      modelId: 'claude-fake',
      account: 'a@x.com',
    })
  })

  test('createSubrouter passes log into models without leaking between instances', async () => {
    const anthropicMock = await startMockServer(() => anthropic429)
    const opencodeMock = await startMockServer(() => chatCompletionOk('hello from fallback'))
    servers = [anthropicMock, opencodeMock]
    process.env.SUBROUTER_ANTHROPIC_BASE_URL = `${anthropicMock.url}/v1`
    process.env.SUBROUTER_OPENCODE_GO_BASE_URL = `${opencodeMock.url}/v1`

    await addAccount({ provider: 'anthropic', account: oauthAccount({ email: 'a@x.com', refresh: 'r1', access: 'acc1' }) })
    await addAccount({
      provider: 'opencode-go',
      account: { type: 'api', key: 'zen-key', addedAt: 1, lastUsed: 1 },
    })
    await savePreset({ name: 'test', models: ['anthropic/claude-fake', 'opencode-go/fake-model'] })

    const logs: SubrouterLogEntry[] = []
    const otherLogs: SubrouterLogEntry[] = []
    const sdk = createSubrouter({
      log: (entry) => {
        logs.push(entry)
      },
    })
    createSubrouter({
      log: (entry) => {
        otherLogs.push(entry)
      },
    })
    await sdk.languageModel('test').doGenerate(callOptions)
    expect(logs.map((entry) => `${entry.level} ${entry.message}`)).toEqual([
      'info trying anthropic/claude-fake #1 (a@x.com)',
      'warn failover anthropic/claude-fake #1 (a@x.com)',
      'info trying opencode-go/fake-model #1 (API key)',
    ])
    expect(otherLogs).toEqual([])
  })

  test('persists a short retry-after as the account cooldown', async () => {
    const anthropicMock = await startMockServer(() => ({
      ...anthropic429,
      headers: { 'retry-after': '12' },
    }))
    const opencodeMock = await startMockServer(() => chatCompletionOk('hello from fallback'))
    servers = [anthropicMock, opencodeMock]
    process.env.SUBROUTER_ANTHROPIC_BASE_URL = `${anthropicMock.url}/v1`
    process.env.SUBROUTER_OPENCODE_GO_BASE_URL = `${opencodeMock.url}/v1`

    await addAccount({ provider: 'anthropic', account: oauthAccount({ email: 'a@x.com' }) })
    await addAccount({
      provider: 'opencode-go',
      account: { type: 'api', key: 'zen-key', addedAt: 1, lastUsed: 1 },
    })
    await savePreset({ name: 'test', models: ['anthropic/claude-fake', 'opencode-go/fake-model'] })

    const before = Date.now()
    await new RouterModel({ preset: 'test' }).doGenerate(callOptions)
    const until = (await loadState()).cooldowns['anthropic:a@x.com']
    expect(until).toBeTruthy()
    expect(until! - before).toBeGreaterThan(5_000)
    expect(until! - before).toBeLessThan(13_000)
  })

  test('skips cooled-down accounts on the next call', async () => {
    const anthropicMock = await startMockServer(() => anthropic429)
    const opencodeMock = await startMockServer(() => chatCompletionOk('again'))
    servers = [anthropicMock, opencodeMock]
    process.env.SUBROUTER_ANTHROPIC_BASE_URL = `${anthropicMock.url}/v1`
    process.env.SUBROUTER_OPENCODE_GO_BASE_URL = `${opencodeMock.url}/v1`

    await addAccount({ provider: 'anthropic', account: oauthAccount({ email: 'a@x.com' }) })
    await addAccount({
      provider: 'opencode-go',
      account: { type: 'api', key: 'zen-key', addedAt: 1, lastUsed: 1 },
    })
    await savePreset({ name: 'test', models: ['anthropic/claude-fake', 'opencode-go/fake-model'] })

    const model = new RouterModel({ preset: 'test' })
    await model.doGenerate(callOptions)
    expect(anthropicMock.requests.length).toBe(1)

    // Second call: anthropic is in cooldown, request goes straight to opencode-go
    await model.doGenerate(callOptions)
    expect(anthropicMock.requests.length).toBe(1)
    expect(opencodeMock.requests.length).toBe(2)

    const { candidates, skipped } = await resolveCandidates({
      presetModels: ['anthropic/claude-fake', 'opencode-go/fake-model'],
    })
    expect(candidates.map((c) => c.provider)).toEqual(['opencode-go'])
    expect(skipped.length).toBe(1)
  })

  test('non rate-limit errors are thrown without rotating', async () => {
    const anthropicMock = await startMockServer(() => anthropic400)
    const opencodeMock = await startMockServer(() => chatCompletionOk('should not be reached'))
    servers = [anthropicMock, opencodeMock]
    process.env.SUBROUTER_ANTHROPIC_BASE_URL = `${anthropicMock.url}/v1`
    process.env.SUBROUTER_OPENCODE_GO_BASE_URL = `${opencodeMock.url}/v1`

    await addAccount({ provider: 'anthropic', account: oauthAccount({ email: 'a@x.com' }) })
    await addAccount({
      provider: 'opencode-go',
      account: { type: 'api', key: 'zen-key', addedAt: 1, lastUsed: 1 },
    })
    await savePreset({ name: 'test', models: ['anthropic/claude-fake', 'opencode-go/fake-model'] })

    const model = new RouterModel({ preset: 'test' })
    const result = await model.doGenerate(callOptions).catch((error: Error) => error)
    expect(result instanceof Error).toBe(true)
    expect(opencodeMock.requests.length).toBe(0)
    const state = await loadState()
    expect(Object.keys(state.cooldowns)).toEqual([])
  })

  test('exhausted and cooling-down accounts throw a retryable 429', async () => {
    const anthropicMock = await startMockServer(() => anthropic429)
    const opencodeMock = await startMockServer(() => ({
      status: 429,
      body: JSON.stringify({ error: { message: 'rate limit reached', type: 'rate_limit' } }),
    }))
    servers = [anthropicMock, opencodeMock]
    process.env.SUBROUTER_ANTHROPIC_BASE_URL = `${anthropicMock.url}/v1`
    process.env.SUBROUTER_OPENCODE_GO_BASE_URL = `${opencodeMock.url}/v1`

    await addAccount({ provider: 'anthropic', account: oauthAccount({ email: 'a@x.com' }) })
    await addAccount({
      provider: 'opencode-go',
      account: { type: 'api', key: 'zen-key', addedAt: 1, lastUsed: 1 },
    })
    await savePreset({ name: 'test', models: ['anthropic/claude-fake', 'opencode-go/fake-model'] })

    const model = new RouterModel({ preset: 'test' })
    const result = await model.doGenerate(callOptions).catch((error: Error) => error)
    if (!APICallError.isInstance(result)) throw result
    expect(result).toMatchObject({ statusCode: 429, isRetryable: true })
    expect(AllCandidatesExhaustedError.is(result.cause)).toBe(true)

    const second = await model.doGenerate(callOptions).catch((error: Error) => error)
    if (!APICallError.isInstance(second)) throw second
    expect(second).toMatchObject({ statusCode: 429, isRetryable: true })
    expect(second.message).toContain('cooling down')
    expect(Number(second.responseHeaders?.['retry-after-ms'])).toBeGreaterThan(0)
  })

  test('all cooling-down accounts throw a retryable 429 instead of dying', async () => {
    await addAccount({ provider: 'anthropic', account: oauthAccount({ email: 'a@x.com' }) })
    await savePreset({ name: 'test', models: ['anthropic/claude-fake'] })
    await markCooldown({
      provider: 'anthropic',
      account: oauthAccount({ email: 'a@x.com' }),
      untilMs: Date.now() + 8_000,
    })

    const model = new RouterModel({ preset: 'test' })
    const result = await model.doGenerate(callOptions).catch((error: Error) => error)
    if (!APICallError.isInstance(result)) throw result
    expect(NoUsableAccountError.is(result)).toBe(false)
    expect(result).toMatchObject({ statusCode: 429, isRetryable: true })
    const retryAfterMs = Number(result.responseHeaders?.['retry-after-ms'])
    expect(retryAfterMs).toBeGreaterThan(1_000)
    expect(retryAfterMs).toBeLessThanOrEqual(8_000)
  })

  test('incompatible cooling models do not cause PDF retry loops', async () => {
    const emptyProvider = { models: {} }
    const modelsDev = await startMockServer(() => ({
      status: 200,
      body: JSON.stringify({
        anthropic: emptyProvider,
        openai: emptyProvider,
        xai: {
          models: {
            grok: {
              id: 'grok',
              attachment: true,
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
            },
          },
        },
        'opencode-go': emptyProvider,
        'github-copilot': emptyProvider,
        poe: emptyProvider,
        'minimax-coding-plan': emptyProvider,
        'kimi-for-coding': {
          models: {
            kimi: {
              id: 'kimi',
              attachment: true,
              modalities: { input: ['text', 'image'], output: ['text'] },
            },
          },
        },
        'zai-coding-plan': emptyProvider,
        'alibaba-coding-plan': emptyProvider,
      }),
    }))
    servers = [modelsDev]
    process.env.SUBROUTER_MODELS_DEV_URL = modelsDev.url
    const xai = oauthAccount({ refresh: 'xai-refresh', access: 'xai-access' })
    const kimi: StoredAccount = { type: 'api', key: 'kimi-key', addedAt: 1, lastUsed: 1 }
    await addAccount({ provider: 'xai', account: xai })
    await addAccount({ provider: 'kimi', account: kimi })
    await savePreset({ name: 'test', models: ['xai/grok', 'kimi/kimi'] })
    await markCooldown({ provider: 'kimi', account: kimi, untilMs: Date.now() + 60_000 })

    const result = await new RouterModel({ preset: 'test' })
      .doGenerate({
        prompt: [
          {
            role: 'user',
            content: [
              {
                type: 'file',
                filename: 'document.pdf',
                mediaType: 'application/pdf',
                data: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
              },
            ],
          },
        ],
      })
      .catch((error: Error) => error)

    expect(NoUsableAccountError.is(result)).toBe(true)
    expect(APICallError.isInstance(result)).toBe(false)
  })

  test('resolveActiveCandidate returns the first usable account', async () => {
    await addAccount({ provider: 'anthropic', account: oauthAccount({ email: 'a@x.com' }) })
    await addAccount({
      provider: 'opencode-go',
      account: { type: 'api', key: 'zen-key', addedAt: 1, lastUsed: 1 },
    })
    await savePreset({ name: 'test', models: ['anthropic/claude-fake', 'opencode-go/fake-model'] })

    const active = await resolveActiveCandidate('test')
    expect(active).toMatchObject({ provider: 'anthropic', modelId: 'claude-fake' })
  })

  test('resolveActiveCandidate skips cooled-down accounts', async () => {
    await addAccount({ provider: 'anthropic', account: oauthAccount({ email: 'a@x.com' }) })
    await addAccount({
      provider: 'opencode-go',
      account: { type: 'api', key: 'zen-key', addedAt: 1, lastUsed: 1 },
    })
    await savePreset({ name: 'test', models: ['anthropic/claude-fake', 'opencode-go/fake-model'] })
    await markCooldown({
      provider: 'anthropic',
      account: oauthAccount({ email: 'a@x.com' }),
      untilMs: Date.now() + 60_000,
    })

    const active = await resolveActiveCandidate('test')
    expect(active).toMatchObject({ provider: 'opencode-go', modelId: 'fake-model' })
  })

  test('reports when a cooldown starts a request on a fallback model', async () => {
    const fallbackMock = await startMockServer(() => chatCompletionOk('fallback'))
    servers = [fallbackMock]
    process.env.SUBROUTER_OPENCODE_GO_BASE_URL = `${fallbackMock.url}/v1`
    const anthropic = oauthAccount({ email: 'a@x.com' })
    await addAccount({ provider: 'anthropic', account: anthropic })
    await addAccount({
      provider: 'opencode-go',
      account: { type: 'api', key: 'zen-key', addedAt: 1, lastUsed: 1 },
    })
    await savePreset({ name: 'test', models: ['anthropic/claude-fake', 'opencode-go/fake-model'] })
    await markCooldown({ provider: 'anthropic', account: anthropic, untilMs: Date.now() + 60_000 })
    const notices: unknown[] = []

    await new RouterModel({
      preset: 'test',
      onCooldownFallback: (notice) => {
        notices.push(notice)
        return new Promise<void>(() => {})
      },
    }).doGenerate({
      ...callOptions,
      headers: {
        'x-subrouter-session-id': 'session-1',
        'x-subrouter-opencode-agent': 'build',
        'x-subrouter-opencode-variant': 'high',
      },
    })

    expect(notices).toEqual([
      {
        sessionID: 'session-1',
        agent: 'build',
        variant: 'high',
        preset: 'test',
        preferred: {
          provider: 'anthropic',
          modelId: 'claude-fake',
          retryAfterMs: expect.any(Number),
        },
        active: { provider: 'opencode-go', modelId: 'fake-model' },
      },
    ])
  })

  test('does not report model fallback when another preferred-model account is live', async () => {
    const anthropicMock = await startMockServer(() => ({
      status: 200,
      body: JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'preferred' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    }))
    servers = [anthropicMock]
    process.env.SUBROUTER_ANTHROPIC_BASE_URL = `${anthropicMock.url}/v1`
    const cooling = oauthAccount({ email: 'cooling@x.com' })
    await addAccount({ provider: 'anthropic', account: cooling })
    await addAccount({ provider: 'anthropic', account: oauthAccount({ email: 'live@x.com' }) })
    await savePreset({ name: 'test', models: ['anthropic/claude-fake', 'opencode-go/fake-model'] })
    await markCooldown({ provider: 'anthropic', account: cooling, untilMs: Date.now() + 60_000 })
    const notices: unknown[] = []

    await new RouterModel({
      preset: 'test',
      onCooldownFallback: (notice) => {
        notices.push(notice)
      },
    }).doGenerate(callOptions)

    expect(notices).toEqual([])
  })

  test('doStream returns after HTTP headers, not after the first SSE event', async () => {
    const bodyGate = Promise.withResolvers<void>()
    const opencodeMock = await startChatSseServer({
      writeBody: (res) => {
        void bodyGate.promise.then(() => {
          res.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'fake-model',
              choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
            })}\n\n`,
          )
          res.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'fake-model',
              choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
            })}\n\n`,
          )
          res.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'fake-model',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            })}\n\n`,
          )
          res.end('data: [DONE]\n\n')
        })
      },
    })
    servers = [opencodeMock]
    process.env.SUBROUTER_OPENCODE_GO_BASE_URL = `${opencodeMock.url}/v1`

    await addAccount({
      provider: 'opencode-go',
      account: { type: 'api', key: 'zen-key', addedAt: 1, lastUsed: 1 },
    })
    await savePreset({ name: 'test', models: ['opencode-go/fake-model'] })

    const result = await new RouterModel({ preset: 'test' }).doStream(callOptions)
    bodyGate.resolve()

    const parts: string[] = []
    for await (const part of result.stream) {
      if (part.type === 'text-delta') parts.push(part.delta)
    }
    expect(parts.join('')).toBe('hello')
  })

  test('missing preset throws PresetNotFoundError', async () => {
    const model = new RouterModel({ preset: 'nope' })
    const result = await model.doGenerate(callOptions).catch((error: Error) => error)
    expect(result).toMatchInlineSnapshot(
      `[PresetNotFoundError: Preset nope does not exist. Create it with: subrouter preset create nope]`,
    )
  })
})
