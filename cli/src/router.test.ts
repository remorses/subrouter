/**
 * Router failover tests with fake provider HTTP servers. No real API calls:
 * the anthropic mock returns rate-limit errors, the opencode-go (OpenAI
 * compatible) mock returns canned completions, and we assert the router
 * cycles accounts and providers in order, recording cooldowns.
 */

import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { LanguageModelV3CallOptions } from '@ai-sdk/provider'
import {
  AllCandidatesExhaustedError,
  NoUsableAccountError,
  resolveActiveCandidate,
  resolveCandidates,
  RouterModel,
} from './router.ts'
import { addAccount, loadState, markCooldown, savePreset, type StoredAccount } from './store.ts'

type MockResponse = { status: number; headers?: Record<string, string>; body: string }

type MockServer = {
  url: string
  requests: { path: string; authorization: string | undefined; body: string }[]
  close: () => Promise<void>
  respond: (request: { path: string }) => MockResponse
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
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    respond,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    },
  }
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

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'subrouter-router-'))
  process.env.SUBROUTER_HOME = home
})

afterEach(async () => {
  delete process.env.SUBROUTER_HOME
  delete process.env.SUBROUTER_ANTHROPIC_BASE_URL
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

  test('throws AllCandidatesExhaustedError when every provider is rate limited', async () => {
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
    expect(AllCandidatesExhaustedError.is(result)).toBe(true)

    // Next call fails fast: everything is cooling down
    const second = await model.doGenerate(callOptions).catch((error: Error) => error)
    expect(NoUsableAccountError.is(second)).toBe(true)
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

  test('missing preset throws PresetNotFoundError', async () => {
    const model = new RouterModel({ preset: 'nope' })
    const result = await model.doGenerate(callOptions).catch((error: Error) => error)
    expect(result).toMatchInlineSnapshot(
      `[PresetNotFoundError: Preset nope does not exist. Create it with: subrouter preset create nope]`,
    )
  })
})
