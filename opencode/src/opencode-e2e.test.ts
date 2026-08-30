/**
 * End-to-end test: a real opencode server drives the subrouter provider.
 *
 * No real API requests. Fake HTTP servers play the provider endpoints:
 * anthropic always answers 429 (rate limited), the opencode-go mock streams
 * a canned completion. The test prompts opencode with model subrouter/default
 * and asserts the reply came from the fallback provider, proving the cycling
 * works through the whole opencode -> provider -> router pipeline.
 *
 * Requires built dist (pnpm build) because opencode loads dist/provider.js.
 */

import { createOpencodeClient, type Event } from '@opencode-ai/sdk'
import { createOpencodeServer } from '@opencode-ai/sdk/server'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  OPENAI_WEBSOCKET_SESSION_HEADER,
  OPENAI_WEBSOCKET_TITLE_HEADER,
  addAccount,
  markCooldown,
} from '@subrouter/cli'
import { addSubrouterHeaders } from './provider.ts'

function summarizeSessionEvents(events: Event[]) {
  const summary: Array<{
    type: string
    status?: string
    message?: string
    name?: string
    statusCode?: number
    isRetryable?: boolean
  }> = []
  for (const event of events) {
    if (event.type === 'session.status') {
      const status = event.properties.status
      summary.push({
        type: event.type,
        status: status.type,
        message: status.type === 'retry' ? status.message : undefined,
      })
      continue
    }
    if (event.type === 'session.error') {
      const error = event.properties.error
      if (!error) continue
      const message = typeof error.data.message === 'string' ? error.data.message : undefined
      summary.push({
        type: event.type,
        name: error.name,
        message,
        statusCode: error.name === 'APIError' ? error.data.statusCode : undefined,
        isRetryable: error.name === 'APIError' ? error.data.isRetryable : undefined,
      })
      continue
    }
    if (event.type === 'session.idle') summary.push({ type: event.type })
  }
  return summary
}

type MockServer = {
  url: string
  requests: string[]
  close: () => Promise<void>
}

async function startMockServer(
  handler: (args: { path: string; body: string }, res: import('node:http').ServerResponse) => void,
): Promise<MockServer> {
  const requests: string[] = []
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += String(chunk)
    })
    req.on('end', () => {
      requests.push(req.url ?? '')
      handler({ path: req.url ?? '', body }, res)
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
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    },
  }
}

function sseChunk(data: object) {
  return `data: ${JSON.stringify(data)}\n\n`
}

let home: string
let projectDir: string
let anthropicMock: MockServer
let zenMock: MockServer
let server: { url: string; close: () => void }
const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'subrouter-e2e-'))
  projectDir = path.join(home, 'project')
  await mkdir(projectDir, { recursive: true })

  // Fake anthropic: always rate limited
  anthropicMock = await startMockServer((_request, res) => {
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }))
  })

  // Fake opencode-go: streams a canned completion
  zenMock = await startMockServer(({ body }, res) => {
    const streaming = body.includes('"stream":true')
    if (!streaming) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 1,
          model: 'fake-model',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'hello from fallback' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
      )
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(
      sseChunk({
        id: '1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fake-model',
        choices: [
          { index: 0, delta: { role: 'assistant', content: 'hello from fallback' }, finish_reason: null },
        ],
      }),
    )
    res.write(
      sseChunk({
        id: '1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fake-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
    )
    res.write('data: [DONE]\n\n')
    res.end()
  })

  // Subrouter state: one rate-limited anthropic account + one zen key
  const subrouterHome = path.join(home, 'subrouter')
  await mkdir(subrouterHome, { recursive: true })

  for (const [key, value] of Object.entries({
    SUBROUTER_HOME: subrouterHome,
    SUBROUTER_ANTHROPIC_BASE_URL: `${anthropicMock.url}/v1`,
    SUBROUTER_OPENCODE_GO_BASE_URL: `${zenMock.url}/v1`,
    // Isolate opencode from the user's real global config and auth
    XDG_CONFIG_HOME: path.join(home, 'xdg-config'),
    XDG_DATA_HOME: path.join(home, 'xdg-data'),
    XDG_CACHE_HOME: path.join(home, 'xdg-cache'),
    XDG_STATE_HOME: path.join(home, 'xdg-state'),
  })) {
    savedEnv[key] = process.env[key]
    process.env[key] = value
  }

  await addAccount({
    provider: 'anthropic',
    account: {
      type: 'oauth',
      refresh: 'fake-refresh',
      access: 'fake-access',
      expires: Date.now() + 1_000_000_000,
      email: 'a@x.com',
      addedAt: 1,
      lastUsed: 1,
    },
  })
  await addAccount({
    provider: 'opencode-go',
    account: { type: 'api', key: 'zen-key', addedAt: 1, lastUsed: 1 },
  })

  const providerEntry = pathToFileURL(
    path.join(import.meta.dirname, '..', 'dist', 'provider.js'),
  ).href

  server = await createOpencodeServer({
    port: 0,
    timeout: 60_000,
    config: {
      provider: {
        subrouter: {
          name: 'Subrouter',
          npm: providerEntry,
          models: {
            default: {
              name: 'subrouter default',
              tool_call: true,
              cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
              limit: { context: 200_000, output: 64_000 },
            },
          },
        },
      },
    },
  })
}, 120_000)

afterAll(async () => {
  server?.close()
  await anthropicMock?.close()
  await zenMock?.close()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(home, { recursive: true, force: true })
})

describe('opencode + subrouter provider', () => {
  test('adds session affinity headers for subrouter models', async () => {
    const output = { headers: {} }
    addSubrouterHeaders(
      {
        sessionID: 'session-1',
        agent: 'build',
        model: { providerID: 'subrouter' },
      },
      output,
    )
    expect(output.headers).toEqual({ [OPENAI_WEBSOCKET_SESSION_HEADER]: 'session-1' })

    addSubrouterHeaders(
      {
        sessionID: 'session-2',
        agent: 'title',
        model: { providerID: 'subrouter' },
      },
      output,
    )
    expect(output.headers).toEqual({
      [OPENAI_WEBSOCKET_SESSION_HEADER]: 'session-2',
      [OPENAI_WEBSOCKET_TITLE_HEADER]: 'true',
    })
  })

  test('rate-limited provider is cycled to the fallback through opencode', async () => {
    const client = createOpencodeClient({ baseUrl: server.url })

    const session = await client.session.create({
      query: { directory: projectDir },
      body: { title: 'subrouter e2e' },
    })
    expect(session.data).toBeTruthy()

    const result = await client.session.prompt({
      path: { id: session.data!.id },
      query: { directory: projectDir },
      body: {
        model: { providerID: 'subrouter', modelID: 'default' },
        parts: [{ type: 'text', text: 'say hi' }],
      },
    })

    const parts = result.data?.parts ?? []
    const texts = parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    expect(texts).toContain('hello from fallback')

    // The anthropic mock was tried first and rate limited
    expect(anthropicMock.requests.length).toBeGreaterThan(0)
    expect(zenMock.requests.length).toBeGreaterThan(0)
  }, 120_000)

  test('all cooling-down accounts retry through opencode instead of dying', async () => {
    const untilMs = Date.now() + 2_000
    await markCooldown({
      provider: 'anthropic',
      account: { type: 'oauth', refresh: 'fake-refresh', access: 'fake-access', email: 'a@x.com', addedAt: 1, lastUsed: 1 },
      untilMs,
    })
    await markCooldown({
      provider: 'opencode-go',
      account: { type: 'api', key: 'zen-key', addedAt: 1, lastUsed: 1 },
      untilMs,
    })

    const client = createOpencodeClient({ baseUrl: server.url })
    const events: Event[] = []
    const subscription = await client.event.subscribe({
      query: { directory: projectDir },
    })
    void (async () => {
      for await (const event of subscription.stream) {
        events.push(event)
      }
    })()

    const session = await client.session.create({
      query: { directory: projectDir },
      body: { title: 'subrouter cooldown retry' },
    })
    expect(session.data).toBeTruthy()

    const result = await client.session.prompt({
      path: { id: session.data!.id },
      query: { directory: projectDir },
      body: {
        model: { providerID: 'subrouter', modelID: 'default' },
        parts: [{ type: 'text', text: 'say hi' }],
      },
    })

    const parts = result.data?.parts ?? []
    const texts = parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    expect(texts).toContain('hello from fallback')

    const summary = summarizeSessionEvents(events)
    expect(summary.some((event) => event.status === 'retry')).toBe(true)
    expect(summary.some((event) => event.name === 'UnknownError')).toBe(false)
    expect(
      summary.map((event) => {
        if (event.status === 'retry') {
          return { status: 'retry', coolingDown: event.message?.includes('cooling down') }
        }
        return event.status ?? event.type
      }),
    ).toMatchInlineSnapshot(`
      [
        "busy",
        "busy",
        {
          "coolingDown": true,
          "status": "retry",
        },
        "busy",
      ]
    `)
  }, 120_000)
})
