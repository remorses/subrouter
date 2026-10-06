/** Tests the OpenAI Codex WebSocket transport through the real AI SDK model. */

import {
  APICallError,
  type JSONObject,
  type LanguageModelV3CallOptions,
  type LanguageModelV3StreamPart,
} from '@ai-sdk/provider'
import * as errore from 'errore'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { RouterModel } from '../router.ts'
import { addAccount, loadState, savePreset, type StoredAccount } from '../store.ts'
import {
  closeOpenAIWebSockets,
  openaiAdapter,
  OPENAI_WEBSOCKET_SESSION_HEADER,
} from './openai.ts'

type CodexServer = Awaited<ReturnType<typeof startCodexServer>>

const callOptions: LanguageModelV3CallOptions = {
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  headers: { [OPENAI_WEBSOCKET_SESSION_HEADER]: 'session-1' },
}

function forkOptions(session: string, text: string): LanguageModelV3CallOptions {
  return {
    prompt: [
      { role: 'system', content: 'Shared inert reference context. '.repeat(64) },
      { role: 'user', content: [{ type: 'text', text }] },
    ],
    headers: {
      [OPENAI_WEBSOCKET_SESSION_HEADER]: session,
      'x-session-affinity': session,
      'X-Session-Id': session,
      'x-opencode-session-id': session,
    },
  }
}

function requestText(request: JSONObject) {
  if (!Array.isArray(request.input)) throw new Error('Expected full request input')
  const message = request.input.at(-1)
  if (!message || typeof message !== 'object' || Array.isArray(message) || !Array.isArray(message.content)) {
    throw new Error('Expected a final user message')
  }
  const content = message.content[0]
  if (!content || typeof content !== 'object' || Array.isArray(content) || typeof content.text !== 'string') {
    throw new Error('Expected user text')
  }
  return content.text
}

function oauthAccount({ accountId, access }: { accountId: string; access: string }): StoredAccount {
  return {
    type: 'oauth',
    refresh: `refresh-${accountId}`,
    access,
    expires: Date.now() + 60 * 60 * 1000,
    accountId,
    addedAt: 1,
    lastUsed: 1,
  }
}

function completionEvents({ text, responseId }: { text: string; responseId: string }) {
  return [
    {
      type: 'response.created',
      response: { id: responseId, created_at: 1, model: 'gpt-test', service_tier: null },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: `msg-${responseId}`, role: 'assistant', status: 'in_progress', content: [] },
    },
    { type: 'response.content_part.added', part: { type: 'output_text', text: '' } },
    { type: 'response.output_text.delta', item_id: `msg-${responseId}`, delta: text },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id: `msg-${responseId}`,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text }],
      },
    },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        status: 'completed',
        usage: {
          input_tokens: 5,
          output_tokens: 3,
          total_tokens: 8,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    },
  ]
}

async function startCodexServer(
  respond: (input: { authorization: string; request: JSONObject; socket: WebSocket }) => void,
  { rejectWebSocket = false }: { rejectWebSocket?: boolean } = {},
) {
  const connections: Array<{ authorization: string; beta: string }> = []
  const websocketRequests: JSONObject[] = []
  const httpRequests: JSONObject[] = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += String(chunk)
    })
    request.on('end', () => {
      const payload: JSONObject = JSON.parse(body)
      httpRequests.push(payload)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of completionEvents({ text: 'http', responseId: 'http-1' })) {
        response.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      response.end('data: [DONE]\n\n')
    })
  })
  const webSocketServer = new WebSocketServer({
    server,
    verifyClient: rejectWebSocket ? (_info, done) => done(false, 503, 'Unavailable') : undefined,
  })
  webSocketServer.on('connection', (socket, request) => {
    const authorization = request.headers.authorization ?? ''
    connections.push({
      authorization,
      beta: String(request.headers['openai-beta'] ?? ''),
    })
    socket.on('message', (data) => {
      const payload: JSONObject = JSON.parse(data.toString())
      websocketRequests.push(payload)
      respond({ authorization, request: payload, socket })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Codex test server has no address')
  return {
    connections,
    httpRequests,
    server,
    url: `http://127.0.0.1:${address.port}`,
    websocketRequests,
    webSocketServer,
  }
}

async function closeCodexServer(server: CodexServer) {
  for (const socket of server.webSocketServer.clients) socket.terminate()
  await new Promise<void>((resolve) => server.webSocketServer.close(() => resolve()))
  await new Promise<void>((resolve) => server.server.close(() => resolve()))
}

async function textFromStream(stream: ReadableStream<LanguageModelV3StreamPart>) {
  const parts: LanguageModelV3StreamPart[] = []
  for await (const part of stream) parts.push(part)
  return parts.flatMap((part) => (part.type === 'text-delta' ? [part.delta] : [])).join('')
}

let home: string
let servers: CodexServer[] = []

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'subrouter-openai-ws-'))
  process.env.SUBROUTER_HOME = home
})

afterEach(async () => {
  vi.restoreAllMocks()
  closeOpenAIWebSockets()
  delete process.env.SUBROUTER_OPENAI_BASE_URL
  for (const server of servers) await closeCodexServer(server)
  servers = []
  await rm(home, { recursive: true, force: true })
})

describe('OpenAI Codex WebSocket transport', () => {
  test('reuses a compatible idle parent connection for a fork without changing either full request', async () => {
    const server = await startCodexServer(({ request, socket }) => {
      const text = requestText(request)
      for (const event of completionEvents({ text, responseId: text })) socket.send(JSON.stringify(event))
    })
    servers.push(server)
    process.env.SUBROUTER_OPENAI_BASE_URL = server.url
    const account = oauthAccount({ accountId: 'account-1', access: 'access-1' })
    const model = openaiAdapter.createModel({ modelId: 'gpt-test', account, persist: async () => {} })

    for (const [session, text] of [['parent', 'parent-input'], ['fork', 'fork-input'], ['parent', 'parent-resumed']] as const) {
      expect(await textFromStream((await model.doStream(forkOptions(session, text))).stream)).toBe(text)
    }
    expect(server.connections).toHaveLength(1)
    expect(server.httpRequests).toEqual([])
    expect(server.websocketRequests.map(requestText)).toEqual(['parent-input', 'fork-input', 'parent-resumed'])
    expect(server.websocketRequests.every((request) => !('previous_response_id' in request))).toBe(true)
    expect(server.websocketRequests.map((request) => request.input)).toEqual([
      [{ role: 'system', content: 'Shared inert reference context. '.repeat(64) },
        { role: 'user', content: [{ type: 'input_text', text: 'parent-input' }] }],
      [{ role: 'system', content: 'Shared inert reference context. '.repeat(64) },
        { role: 'user', content: [{ type: 'input_text', text: 'fork-input' }] }],
      [{ role: 'system', content: 'Shared inert reference context. '.repeat(64) },
        { role: 'user', content: [{ type: 'input_text', text: 'parent-resumed' }] }],
    ])
  })

  test('preserves simultaneous parent and fork streams and isolates fork cancellation after idle reuse', async () => {
    const held = new Map<string, WebSocket>()
    const server = await startCodexServer(({ request, socket }) => {
      const text = requestText(request)
      const events = completionEvents({ text, responseId: text })
      if (text === 'warm') {
        for (const event of events) socket.send(JSON.stringify(event))
      } else {
        held.set(text, socket)
        socket.send(JSON.stringify(events[0]))
      }
    })
    servers.push(server)
    process.env.SUBROUTER_OPENAI_BASE_URL = server.url
    const account = oauthAccount({ accountId: 'account-1', access: 'access-1' })
    const model = openaiAdapter.createModel({ modelId: 'gpt-test', account, persist: async () => {} })
    expect(await textFromStream((await model.doStream(forkOptions('parent', 'warm'))).stream)).toBe('warm')
    const cancellation = new AbortController()
    const fork = await model.doStream({ ...forkOptions('fork', 'fork-active'), abortSignal: cancellation.signal })
    const forkResult = textFromStream(fork.stream).catch((error: unknown) => error)
    const parent = await model.doStream(forkOptions('parent', 'parent-active'))
    const parentResult = textFromStream(parent.stream)

    expect(server.connections).toHaveLength(2)
    expect(held.get('parent-active')).not.toBe(held.get('fork-active'))
    cancellation.abort()
    expect(errore.isAbortError(await forkResult)).toBe(true)
    const parentSocket = held.get('parent-active')
    if (!parentSocket) throw new Error('Parent connection missing')
    expect(parentSocket.readyState).toBe(WebSocket.OPEN)
    for (const event of completionEvents({ text: 'parent-active', responseId: 'parent-active' }).slice(1)) {
      parentSocket.send(JSON.stringify(event))
    }
    expect(await parentResult).toBe('parent-active')
    expect(server.httpRequests).toEqual([])
  })

  test.each(['prefix', 'model', 'tools', 'headers', 'response-reference'])('does not reuse incompatible %s across sessions', async (difference) => {
    const server = await startCodexServer(({ socket }) => {
      for (const event of completionEvents({ text: 'ok', responseId: 'ok' })) socket.send(JSON.stringify(event))
    })
    servers.push(server)
    process.env.SUBROUTER_OPENAI_BASE_URL = server.url
    const account = oauthAccount({ accountId: 'account-1', access: 'access-1' })
    const model = openaiAdapter.createModel({ modelId: 'gpt-test', account, persist: async () => {} })
    await textFromStream((await model.doStream(forkOptions('parent', 'parent'))).stream)
    const options = forkOptions('fork', 'fork')
    if (difference === 'prefix') options.prompt[0] = { role: 'system', content: 'Different context' }
    if (difference === 'tools') options.tools = [{ type: 'function', name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } }]
    if (difference === 'headers') options.headers = { ...options.headers, 'x-codex-turn-state': 'different-turn' }
    if (difference === 'response-reference') options.providerOptions = { openai: { previousResponseId: 'other-response' } }
    const target = difference === 'model'
      ? openaiAdapter.createModel({ modelId: 'gpt-other', account, persist: async () => {} })
      : model
    expect(await textFromStream((await target.doStream(options)).stream)).toBe('ok')
    expect(server.connections).toHaveLength(2)
    expect(server.httpRequests).toEqual([])
  })

  test.each(['account', 'token', 'endpoint'])('keeps warm connections isolated by %s', async (difference) => {
    const respond = ({ socket }: { socket: WebSocket }) => {
      for (const event of completionEvents({ text: 'ok', responseId: 'ok' })) socket.send(JSON.stringify(event))
    }
    const server = await startCodexServer(respond)
    servers.push(server)
    process.env.SUBROUTER_OPENAI_BASE_URL = server.url
    const account = oauthAccount({ accountId: 'account-1', access: 'access-1' })
    const model = openaiAdapter.createModel({ modelId: 'gpt-test', account, persist: async () => {} })
    await textFromStream((await model.doStream(forkOptions('parent', 'parent'))).stream)
    const otherServer = difference === 'endpoint' ? await startCodexServer(respond) : server
    if (otherServer !== server) servers.push(otherServer)
    process.env.SUBROUTER_OPENAI_BASE_URL = otherServer.url
    const otherAccount = oauthAccount({
      accountId: difference === 'account' ? 'account-2' : 'account-1',
      access: difference === 'token' ? 'access-2' : 'access-1',
    })
    const other = openaiAdapter.createModel({ modelId: 'gpt-test', account: otherAccount, persist: async () => {} })
    expect(await textFromStream((await other.doStream(forkOptions('fork', 'fork'))).stream)).toBe('ok')
    expect(servers.flatMap((item) => item.connections)).toHaveLength(2)
  })

  test('does not adopt an expired idle warm connection', async () => {
    const server = await startCodexServer(({ socket }) => {
      for (const event of completionEvents({ text: 'ok', responseId: 'ok' })) socket.send(JSON.stringify(event))
    })
    servers.push(server)
    process.env.SUBROUTER_OPENAI_BASE_URL = server.url
    const account = oauthAccount({ accountId: 'account-1', access: 'access-1' })
    const model = openaiAdapter.createModel({ modelId: 'gpt-test', account, persist: async () => {} })
    await textFromStream((await model.doStream(forkOptions('parent', 'parent'))).stream)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60 * 1000)
    expect(await textFromStream((await model.doStream(forkOptions('fork', 'fork'))).stream)).toBe('ok')
    expect(server.connections).toHaveLength(2)
  })

  test('keeps an owning session response reference on its existing connection', async () => {
    const server = await startCodexServer(({ socket }) => {
      for (const event of completionEvents({ text: 'ok', responseId: 'ok' })) socket.send(JSON.stringify(event))
    })
    servers.push(server)
    process.env.SUBROUTER_OPENAI_BASE_URL = server.url
    const account = oauthAccount({ accountId: 'account-1', access: 'access-1' })
    const model = openaiAdapter.createModel({ modelId: 'gpt-test', account, persist: async () => {} })
    await textFromStream((await model.doStream(forkOptions('parent', 'parent'))).stream)
    await textFromStream((await model.doStream({
      ...forkOptions('parent', 'follow-up'),
      providerOptions: { openai: { previousResponseId: 'ok' } },
    })).stream)
    expect(server.connections).toHaveLength(1)
    expect(server.websocketRequests[1]).toHaveProperty('previous_response_id', 'ok')
  })

  test('an already-aborted fork does not take or close the parent warm connection', async () => {
    const server = await startCodexServer(({ socket }) => {
      for (const event of completionEvents({ text: 'ok', responseId: 'ok' })) socket.send(JSON.stringify(event))
    })
    servers.push(server)
    process.env.SUBROUTER_OPENAI_BASE_URL = server.url
    const account = oauthAccount({ accountId: 'account-1', access: 'access-1' })
    const model = openaiAdapter.createModel({ modelId: 'gpt-test', account, persist: async () => {} })
    await textFromStream((await model.doStream(forkOptions('parent', 'parent'))).stream)
    const cancellation = new AbortController()
    cancellation.abort()
    await expect(Promise.resolve(model.doStream({
      ...forkOptions('fork', 'fork'), abortSignal: cancellation.signal,
    }))).rejects.toSatisfy(errore.isAbortError)
    expect(await textFromStream((await model.doStream(forkOptions('parent', 'resumed'))).stream)).toBe('ok')
    expect(server.connections).toHaveLength(1)
    expect(server.httpRequests).toEqual([])
  })

  test('uses and reuses WebSocket by default across model instances', async () => {
    let count = 0
    const server = await startCodexServer(({ socket }) => {
      count += 1
      for (const event of completionEvents({ text: `ws-${count}`, responseId: `ws-${count}` })) {
        socket.send(JSON.stringify(event))
      }
    })
    servers.push(server)
    process.env.SUBROUTER_OPENAI_BASE_URL = server.url

    const account = oauthAccount({ accountId: 'account-1', access: 'access-1' })
    const first = openaiAdapter.createModel({ modelId: 'gpt-test', account, persist: async () => {} })
    const second = openaiAdapter.createModel({ modelId: 'gpt-test', account, persist: async () => {} })

    expect(await textFromStream((await first.doStream(callOptions)).stream)).toBe('ws-1')
    expect(await textFromStream((await second.doStream(callOptions)).stream)).toBe('ws-2')
    expect(server.connections).toEqual([
      {
        authorization: 'Bearer access-1',
        beta: 'responses_websockets=2026-02-06',
      },
    ])
    expect(server.httpRequests).toEqual([])
    expect(server.websocketRequests).toHaveLength(2)
    expect(server.websocketRequests[0]).toMatchObject({ type: 'response.create', store: false })
    expect(server.websocketRequests[0]).not.toHaveProperty('stream')
    expect(server.websocketRequests[0]).not.toHaveProperty('background')
  })

  test('uses HTTP when no session affinity is available', async () => {
    const server = await startCodexServer(() => {})
    servers.push(server)
    process.env.SUBROUTER_OPENAI_BASE_URL = server.url
    const account = oauthAccount({ accountId: 'account-1', access: 'access-1' })
    const model = openaiAdapter.createModel({ modelId: 'gpt-test', account, persist: async () => {} })

    expect(await textFromStream((await model.doStream({ ...callOptions, headers: {} })).stream)).toBe('http')
    expect(server.connections).toEqual([])
    expect(server.httpRequests).toHaveLength(1)
  })

  test('falls back to HTTP immediately when WebSocket cannot open', async () => {
    const server = await startCodexServer(() => {}, { rejectWebSocket: true })
    servers.push(server)
    process.env.SUBROUTER_OPENAI_BASE_URL = server.url
    const account = oauthAccount({ accountId: 'account-1', access: 'access-1' })
    const model = openaiAdapter.createModel({ modelId: 'gpt-test', account, persist: async () => {} })

    expect(await textFromStream((await model.doStream(callOptions)).stream)).toBe('http')
    expect(server.connections).toEqual([])
    expect(server.httpRequests).toHaveLength(1)
  })

  test('falls back to HTTP when WebSocket closes before output', async () => {
    const server = await startCodexServer(({ socket }) => {
      socket.close(1011, 'transport failed')
    })
    servers.push(server)
    process.env.SUBROUTER_OPENAI_BASE_URL = server.url
    const account = oauthAccount({ accountId: 'account-1', access: 'access-1' })
    const model = openaiAdapter.createModel({ modelId: 'gpt-test', account, persist: async () => {} })

    expect(await textFromStream((await model.doStream(callOptions)).stream)).toBe('http')
    expect(server.connections).toHaveLength(1)
    expect(server.httpRequests).toHaveLength(1)
  })

  test('propagates abort errors without HTTP fallback', async () => {
    const server = await startCodexServer(() => {})
    servers.push(server)
    process.env.SUBROUTER_OPENAI_BASE_URL = server.url
    const account = oauthAccount({ accountId: 'account-1', access: 'access-1' })
    const model = openaiAdapter.createModel({ modelId: 'gpt-test', account, persist: async () => {} })
    const controller = new AbortController()
    controller.abort()

    await expect(
      Promise.resolve(model.doStream({ ...callOptions, abortSignal: controller.signal })),
    ).rejects.toSatisfy(errore.isAbortError)
    expect(server.connections).toEqual([])
    expect(server.httpRequests).toEqual([])
  })

  test('falls back to HTTP immediately when the request is too large for WebSocket', async () => {
    const server = await startCodexServer(({ socket }) => {
      socket.close(1009, 'payload too large')
    })
    servers.push(server)
    process.env.SUBROUTER_OPENAI_BASE_URL = server.url
    const account = oauthAccount({ accountId: 'account-1', access: 'access-1' })
    const model = openaiAdapter.createModel({ modelId: 'gpt-test', account, persist: async () => {} })

    expect(await textFromStream((await model.doStream(callOptions)).stream)).toBe('http')
    expect(server.connections).toHaveLength(1)
    expect(server.httpRequests).toHaveLength(1)
  })

  test('preserves a WebSocket 429 and rotates to another account', async () => {
    const server = await startCodexServer(({ authorization, socket }) => {
      if (authorization === 'Bearer access-b') {
        socket.send(
          JSON.stringify({
            type: 'error',
            status: 429,
            headers: { 'retry-after': '600' },
            error: { type: 'usage_limit_reached', message: 'The usage limit has been reached' },
          }),
        )
        return
      }
      for (const event of completionEvents({ text: 'fallback', responseId: 'fallback-1' })) {
        socket.send(JSON.stringify(event))
      }
    })
    servers.push(server)
    process.env.SUBROUTER_OPENAI_BASE_URL = server.url

    await addAccount({ provider: 'openai', account: oauthAccount({ accountId: 'account-a', access: 'access-a' }) })
    await addAccount({ provider: 'openai', account: oauthAccount({ accountId: 'account-b', access: 'access-b' }) })
    await savePreset({ name: 'test', models: ['openai/gpt-test'] })

    const result = await new RouterModel({ preset: 'test' }).doStream(callOptions)
    expect(await textFromStream(result.stream)).toBe('fallback')
    expect(server.connections.map((item) => item.authorization)).toEqual([
      'Bearer access-b',
      'Bearer access-a',
    ])
    expect(server.httpRequests).toEqual([])
    expect(Object.keys((await loadState()).cooldowns)).toEqual(['openai:account-b'])
  })

  test.each([
    {
      name: 'WebSocket connection loss',
      fail: (socket: WebSocket) => socket.terminate(),
      message: 'closed before response completed (code 1006',
      statusCode: undefined,
      // A 1006 drop is a transient transport failure, not a quota/auth
      // rejection, so it must retry without cooling down the account.
      cooldowns: [] satisfies string[],
    },
    {
      name: 'WebSocket service restart',
      fail: (socket: WebSocket) => socket.close(1012, 'service restart'),
      message: 'closed before response completed (code 1012',
      statusCode: undefined,
      cooldowns: [] satisfies string[],
    },
    {
      name: 'Grok-style 403',
      fail: (socket: WebSocket) =>
        socket.send(
          JSON.stringify({
            type: 'error',
            status_code: 403,
            error: {
              type: 'personal-team-blocked:spending-limit',
              message: 'You have run out of credits or need a Grok subscription.',
            },
          }),
        ),
      message: 'run out of credits',
      statusCode: 403,
      cooldowns: ['openai:account-b'],
    },
  ])('marks $name retryable before semantic output', async ({ fail, message, statusCode, cooldowns }) => {
    const server = await startCodexServer(({ authorization, socket }) => {
      if (authorization !== 'Bearer access-b') {
        for (const event of completionEvents({ text: 'must not run', responseId: 'fallback-1' })) {
          socket.send(JSON.stringify(event))
        }
        return
      }
      socket.send(JSON.stringify(completionEvents({ text: 'partial', responseId: 'partial-1' })[0]))
      setTimeout(() => fail(socket), 20)
    })
    servers.push(server)
    process.env.SUBROUTER_OPENAI_BASE_URL = server.url
    await addAccount({ provider: 'openai', account: oauthAccount({ accountId: 'account-a', access: 'access-a' }) })
    await addAccount({ provider: 'openai', account: oauthAccount({ accountId: 'account-b', access: 'access-b' }) })
    await savePreset({ name: 'test', models: ['openai/gpt-test'] })

    const result = await new RouterModel({ preset: 'test' }).doStream(callOptions)
    const error = await (async () => {
      for await (const _part of result.stream) {
      }
    })().catch((cause) => cause as Error)
    expect(APICallError.isInstance(error)).toBe(true)
    if (!APICallError.isInstance(error)) throw error
    expect(error.isRetryable).toBe(true)
    expect(error.statusCode).toBe(statusCode)
    expect(error.message).toContain(message)
    expect(server.connections.map((item) => item.authorization)).toEqual(['Bearer access-b'])
    expect(Object.keys((await loadState()).cooldowns)).toEqual(cooldowns)
  })

  test('does not retry a Grok-style 403 after visible output', async () => {
    const server = await startCodexServer(({ authorization, socket }) => {
      if (authorization !== 'Bearer access-b') {
        for (const event of completionEvents({ text: 'must not run', responseId: 'fallback-1' })) {
          socket.send(JSON.stringify(event))
        }
        return
      }
      for (const event of completionEvents({ text: 'partial', responseId: 'partial-1' }).slice(0, 4)) {
        socket.send(JSON.stringify(event))
      }
      setTimeout(() => {
        socket.send(
          JSON.stringify({
            type: 'error',
            status_code: 403,
            error: {
              type: 'personal-team-blocked:spending-limit',
              message: 'You have run out of credits or need a Grok subscription.',
            },
          }),
        )
      }, 20)
    })
    servers.push(server)
    process.env.SUBROUTER_OPENAI_BASE_URL = server.url
    await addAccount({ provider: 'openai', account: oauthAccount({ accountId: 'account-a', access: 'access-a' }) })
    await addAccount({ provider: 'openai', account: oauthAccount({ accountId: 'account-b', access: 'access-b' }) })
    await savePreset({ name: 'test', models: ['openai/gpt-test'] })

    const result = await new RouterModel({ preset: 'test' }).doStream(callOptions)
    const parts: LanguageModelV3StreamPart[] = []
    const error = await (async () => {
      for await (const part of result.stream) parts.push(part)
    })().catch((cause) => cause as Error)
    expect(parts.map((part) => part.type)).toMatchInlineSnapshot(`
      [
        "stream-start",
        "response-metadata",
        "text-start",
        "text-delta",
      ]
    `)
    expect(APICallError.isInstance(error)).toBe(true)
    if (!APICallError.isInstance(error)) throw error
    expect(error.isRetryable).toBe(false)
    expect(error.statusCode).toBe(403)
    expect(error.message).toContain('run out of credits')
    expect(parts.flatMap((part) => (part.type === 'text-delta' ? [part.delta] : []))).toEqual(['partial'])
    expect(server.connections.map((item) => item.authorization)).toEqual(['Bearer access-b'])
    expect(Object.keys((await loadState()).cooldowns)).toEqual(['openai:account-b'])
  })

  test.each([1006, 1012])('retries a WebSocket %s drop after visible output without cooling down', async (code) => {
    // Unlike a quota/auth error, a transient transport drop is retryable even after
    // output has started, so OpenCode restarts the turn on the same account.
    const server = await startCodexServer(({ authorization, socket }) => {
      if (authorization !== 'Bearer access-b') {
        for (const event of completionEvents({ text: 'must not run', responseId: 'fallback-1' })) {
          socket.send(JSON.stringify(event))
        }
        return
      }
      for (const event of completionEvents({ text: 'partial', responseId: 'partial-1' }).slice(0, 4)) {
        socket.send(JSON.stringify(event))
      }
      setTimeout(() => code === 1006 ? socket.terminate() : socket.close(code, 'service restart'), 20)
    })
    servers.push(server)
    process.env.SUBROUTER_OPENAI_BASE_URL = server.url
    await addAccount({ provider: 'openai', account: oauthAccount({ accountId: 'account-a', access: 'access-a' }) })
    await addAccount({ provider: 'openai', account: oauthAccount({ accountId: 'account-b', access: 'access-b' }) })
    await savePreset({ name: 'test', models: ['openai/gpt-test'] })

    const result = await new RouterModel({ preset: 'test' }).doStream(callOptions)
    const parts: LanguageModelV3StreamPart[] = []
    const error = await (async () => {
      for await (const part of result.stream) parts.push(part)
    })().catch((cause) => cause as Error)
    expect(APICallError.isInstance(error)).toBe(true)
    if (!APICallError.isInstance(error)) throw error
    expect(error.isRetryable).toBe(true)
    expect(error.statusCode).toBeUndefined()
    expect(error.message).toContain(`closed before response completed (code ${code}`)
    expect(parts.flatMap((part) => (part.type === 'text-delta' ? [part.delta] : []))).toEqual(['partial'])
    expect(server.connections.map((item) => item.authorization)).toEqual(['Bearer access-b'])
    expect(Object.keys((await loadState()).cooldowns)).toEqual([])
  })
})
