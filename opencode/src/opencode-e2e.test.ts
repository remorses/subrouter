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
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import {
  OPENCODE_AGENT_HEADER,
  OPENCODE_VARIANT_HEADER,
  OPENAI_WEBSOCKET_SESSION_HEADER,
  ROUTE_AFFINITY_HEADER,
  OPENAI_WEBSOCKET_TITLE_HEADER,
  addAccount,
  clearCooldowns,
  markCooldown,
  savePreset,
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
  requests: Array<{ path: string; body: string }>
  close: () => Promise<void>
}

type MockHandler = (
  args: { path: string; body: string },
  res: import('node:http').ServerResponse,
) => void

async function startMockServer(
  handler: MockHandler,
): Promise<MockServer> {
  const requests: MockServer['requests'] = []
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += String(chunk)
    })
    req.on('end', () => {
      requests.push({ path: req.url ?? '', body })
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
let modelsDevMock: MockServer
let zenMock: MockServer
let openaiMock: MockServer
let zenRespond: MockHandler
let defaultZenRespond: MockHandler
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
  defaultZenRespond = ({ body }, res) => {
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
  }
  zenRespond = defaultZenRespond
  zenMock = await startMockServer((request, response) => zenRespond(request, response))

  openaiMock = await startMockServer((_request, res) => {
    const text = 'hello from openai'
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of [
      {
        type: 'response.created',
        response: { id: 'resp-1', created_at: 1, model: 'gpt-5.5', service_tier: null },
      },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', id: 'msg-1', role: 'assistant', status: 'in_progress', content: [] },
      },
      { type: 'response.content_part.added', part: { type: 'output_text', text: '' } },
      { type: 'response.output_text.delta', item_id: 'msg-1', delta: text },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'message',
          id: 'msg-1',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text }],
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp-1',
          status: 'completed',
          usage: {
            input_tokens: 5,
            output_tokens: 3,
            total_tokens: 8,
            input_tokens_details: { cached_tokens: 0 },
          },
        },
      },
    ]) {
      res.write(sseChunk(event))
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })

  modelsDevMock = await startMockServer((_request, res) => {
    const emptyProvider = { models: {} }
    const pdfModel = (id: string) => ({
      id,
      attachment: true,
      modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
      limit: { context: 200_000, output: 64_000 },
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        anthropic: { models: { 'claude-opus-4-6': pdfModel('claude-opus-4-6') } },
        openai: { models: { 'gpt-5.5': pdfModel('gpt-5.5') } },
        xai: emptyProvider,
        'opencode-go': { models: { 'grok-4.6': pdfModel('grok-4.6') } },
        'github-copilot': emptyProvider,
        poe: emptyProvider,
        'minimax-coding-plan': emptyProvider,
        'kimi-for-coding': emptyProvider,
        'zai-coding-plan': emptyProvider,
        'alibaba-coding-plan': emptyProvider,
      }),
    )
  })

  // Subrouter state: one rate-limited anthropic account + one zen key
  const subrouterHome = path.join(home, 'subrouter')
  await mkdir(subrouterHome, { recursive: true })

  for (const [key, value] of Object.entries({
    SUBROUTER_HOME: subrouterHome,
    SUBROUTER_ANTHROPIC_BASE_URL: `${anthropicMock.url}/v1`,
    SUBROUTER_MODELS_DEV_URL: modelsDevMock.url,
    SUBROUTER_OPENCODE_GO_BASE_URL: `${zenMock.url}/v1`,
    SUBROUTER_OPENAI_BASE_URL: openaiMock.url,
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
  await addAccount({
    provider: 'openai',
    account: {
      type: 'oauth',
      refresh: 'openai-refresh',
      access: 'openai-access',
      expires: Date.now() + 1_000_000_000,
      email: 'o@x.com',
      addedAt: 1,
      lastUsed: 1,
    },
  })
  await savePreset({
    name: 'default',
    models: ['anthropic/claude-opus-4-6', 'opencode-go/grok-4.6'],
  })
  await savePreset({ name: 'openai-only', models: ['openai/gpt-5.5'] })

  const providerEntry = pathToFileURL(
    path.join(import.meta.dirname, '..', 'dist', 'provider.js'),
  ).href
  const pluginEntry = pathToFileURL(
    path.join(import.meta.dirname, '..', 'dist', 'index.js'),
  ).href

  server = await createOpencodeServer({
    port: 0,
    timeout: 60_000,
    config: {
      plugin: [pluginEntry],
      provider: {
        subrouter: {
          name: 'Subrouter',
          npm: providerEntry,
          models: {
            default: {
              name: 'subrouter default',
              tool_call: true,
              attachment: true,
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
              cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
              limit: { context: 200_000, output: 64_000 },
            },
          },
        },
      },
    },
  })
}, 120_000)

afterEach(() => {
  zenRespond = defaultZenRespond
})

afterAll(async () => {
  server?.close()
  await anthropicMock?.close()
  await modelsDevMock?.close()
  await zenMock?.close()
  await openaiMock?.close()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(home, { recursive: true, force: true })
})

describe('opencode + subrouter provider', () => {
  test('adds session affinity headers for subrouter models', async () => {
    const output = { headers: {} }
    addSubrouterHeaders({
      input: {
        sessionID: 'session-1',
        agent: 'build',
        model: { providerID: 'subrouter' },
        message: {
          id: 'message-1',
          agent: 'build',
          model: { providerID: 'subrouter', modelID: 'build', variant: 'high' },
        },
      },
      output,
    })
    expect(output.headers).toEqual({
      [OPENAI_WEBSOCKET_SESSION_HEADER]: 'session-1',
      [ROUTE_AFFINITY_HEADER]: 'message-1',
      [OPENCODE_AGENT_HEADER]: 'build',
      [OPENCODE_VARIANT_HEADER]: 'high',
    })

    const titleOutput = { headers: {} }
    addSubrouterHeaders({
      input: {
        sessionID: 'session-2',
        agent: 'title',
        model: { providerID: 'subrouter' },
        message: {
          id: 'message-1',
          agent: 'build',
          model: { providerID: 'subrouter', modelID: 'build', variant: 'high' },
        },
      },
      output: titleOutput,
    })
    expect(titleOutput.headers).toEqual({
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

  test('a pre-existing cooldown appends one ignored notice without another model turn', async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const session = await client.session.create({
      query: { directory: projectDir },
      body: { title: 'subrouter route notice' },
    })
    expect(session.data).toBeTruthy()
    const requestsBefore = zenMock.requests.length

    const result = await client.session.prompt({
      path: { id: session.data!.id },
      query: { directory: projectDir },
      body: {
        model: { providerID: 'subrouter', modelID: 'default' },
        parts: [{ type: 'text', text: 'say hi again' }],
      },
    })
    expect(
      (result.data?.parts ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n'),
    ).toContain('hello from fallback')

    await expect
      .poll(async () => {
        const messages = await client.session.messages({
          path: { id: session.data!.id },
          query: { directory: projectDir },
        })
        return (messages.data ?? []).filter(({ parts }) =>
          parts.some((part) => part.type === 'text' && part.ignored === true),
        ).length
      })
      .toBe(1)

    const messages = await client.session.messages({
      path: { id: session.data!.id },
      query: { directory: projectDir },
    })
    expect((messages.data ?? []).filter(({ info }) => info.role === 'user')).toHaveLength(2)
    expect((messages.data ?? []).filter(({ info }) => info.role === 'assistant')).toHaveLength(1)
    expect(zenMock.requests).toHaveLength(requestsBefore + 1)
  }, 120_000)

  test('PDF file parts reach a compatible fallback through opencode', async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const session = await client.session.create({
      query: { directory: projectDir },
      body: { title: 'subrouter PDF e2e' },
    })
    expect(session.data).toBeTruthy()

    const result = await client.session.prompt({
      path: { id: session.data!.id },
      query: { directory: projectDir },
      body: {
        model: { providerID: 'subrouter', modelID: 'default' },
        parts: [
          {
            type: 'file',
            filename: 'document.pdf',
            mime: 'application/pdf',
            url: `data:application/pdf;base64,${Buffer.from('%PDF-1.4\n%%EOF').toString('base64')}`,
          },
          { type: 'text', text: 'read the PDF' },
        ],
      },
    })

    const texts = (result.data?.parts ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    expect(texts).toContain('hello from fallback')
    const request = zenMock.requests.at(-1)
    expect(request).toBeTruthy()
    const body = JSON.parse(request!.body) as {
      messages: Array<{ content: Array<{ type: string; file?: { filename?: string } }> }>
    }
    expect(body.messages.at(-1)?.content).toEqual([
      {
        type: 'file',
        file: {
          filename: 'document.pdf',
          file_data: `data:application/pdf;base64,${Buffer.from('%PDF-1.4\n%%EOF').toString('base64')}`,
        },
      },
      { type: 'text', text: 'read the PDF' },
    ])
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

  test('keeps the fallback candidate through tool follow-ups until the session is idle', async () => {
    await clearCooldowns()
    await markCooldown({
      provider: 'anthropic',
      account: {
        type: 'oauth',
        refresh: 'fake-refresh',
        access: 'fake-access',
        email: 'a@x.com',
        addedAt: 1,
        lastUsed: 1,
      },
      untilMs: Date.now() + 60_000,
    })
    const readable = path.join(projectDir, 'message.txt')
    await writeFile(readable, 'tool result')
    const fallbackBodies: string[] = []
    let fallbackCalls = 0
    let cooldownCleared = Promise.resolve()
    zenRespond = ({ body }, res) => {
      fallbackBodies.push(body)
      fallbackCalls++
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (fallbackCalls === 1) {
        cooldownCleared = clearCooldowns()
        res.write(
          sseChunk({
            id: 'tool-1',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fake-model',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-read',
                      type: 'function',
                      function: { name: 'read', arguments: JSON.stringify({ filePath: readable }) },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }),
        )
        res.write(
          sseChunk({
            id: 'tool-1',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fake-model',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          }),
        )
        res.end('data: [DONE]\n\n')
        return
      }
      res.write(
        sseChunk({
          id: 'text-1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fake-model',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
        }),
      )
      res.write(
        sseChunk({
          id: 'text-1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fake-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
      )
      res.end('data: [DONE]\n\n')
    }

    const client = createOpencodeClient({ baseUrl: server.url })
    const session = await client.session.create({
      query: { directory: projectDir },
      body: { title: 'subrouter tool affinity' },
    })
    const anthropicBefore = anthropicMock.requests.length
    await client.session.prompt({
      path: { id: session.data!.id },
      query: { directory: projectDir },
      body: {
        model: { providerID: 'subrouter', modelID: 'default' },
        parts: [{ type: 'text', text: 'read the file' }],
      },
    })
    expect(anthropicMock.requests).toHaveLength(anthropicBefore)
    expect(
      fallbackBodies
        .slice(0, 2)
        .map((body) => body.includes('You are powered by the model named grok-4.6')),
    ).toEqual([true, true])

    await cooldownCleared
    await clearCooldowns()
    await client.session.prompt({
      path: { id: session.data!.id },
      query: { directory: projectDir },
      body: {
        model: { providerID: 'subrouter', modelID: 'default' },
        parts: [{ type: 'text', text: 'say done' }],
      },
    })
    expect(anthropicMock.requests).toHaveLength(anthropicBefore + 1)
    expect(fallbackCalls).toBeGreaterThanOrEqual(3)
  }, 120_000)

  test('openai live model advertises apply_patch and not edit or write', async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const session = await client.session.create({
      query: { directory: projectDir },
      body: { title: 'subrouter apply_patch' },
    })
    expect(session.data).toBeTruthy()

    const result = await client.session.prompt({
      path: { id: session.data!.id },
      query: { directory: projectDir },
      body: {
        model: { providerID: 'subrouter', modelID: 'openai-only' },
        parts: [{ type: 'text', text: 'say hi' }],
      },
    })
    const texts = (result.data?.parts ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    expect(texts).toContain('hello from openai')
    expect(openaiMock.requests.length).toBeGreaterThan(0)

    const raw = openaiMock.requests.at(-1)!.body
    const body = JSON.parse(raw) as {
      tools?: Array<{ name?: string; type?: string; function?: { name?: string } }>
    }
    const names = (body.tools ?? []).map((tool) => tool.name ?? tool.function?.name)
    expect(names).toContain('apply_patch')
    expect(names).not.toContain('edit')
    expect(names).not.toContain('write')
    expect(raw).toContain('apply_patch')
    expect(raw.includes('"name":"edit"') || raw.includes('"name": "edit"')).toBe(false)
  }, 120_000)
})
