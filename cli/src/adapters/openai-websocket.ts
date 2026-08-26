/** OpenAI Responses WebSocket transport with account-safe session pooling. */

import { APICallError, isJSONObject, type JSONObject, type JSONValue } from '@ai-sdk/provider'
import * as errore from 'errore'
import WebSocket from 'ws'

export const OPENAI_WEBSOCKET_TITLE_HEADER = 'x-subrouter-title'
export const OPENAI_WEBSOCKET_SESSION_HEADER = 'x-subrouter-session-id'

const PROTOCOL_HEADER = 'responses_websockets=2026-02-06'
const MESSAGE_TOO_BIG_CLOSE_CODE = 1009
const CONNECT_TIMEOUT_MS = 15_000
const IDLE_TIMEOUT_MS = 5 * 60 * 1000
const MAX_CONNECTION_AGE_MS = 55 * 60 * 1000
const MAX_STREAM_FAILURES = 5
const CONNECTION_LIMIT_REACHED_CODE = 'websocket_connection_limit_reached'

export class OpenAIWebSocketError extends errore.createTaggedError({
  name: 'OpenAIWebSocketError',
  message: 'OpenAI WebSocket failed: $reason',
}) {}

type PoolEntry = {
  socket?: WebSocket
  connectedAt?: number
  lastUsedAt: number
  busy: boolean
  fallback: boolean
  streamFailures: number
}

type AccountPool = {
  accessToken: string
  endpoint: string
  sessions: Map<string, PoolEntry>
}

type WrappedError = {
  status: number
  headers?: Record<string, string>
  body: string
  message: string
}

type FetchArgs = {
  accountKey: string
  accessToken: string
  input: Request | string | URL
  init?: RequestInit
  httpFetch?: typeof globalThis.fetch
}

const accountPools = new Map<string, AccountPool>()
const pruneTimer = setInterval(prune, Math.min(IDLE_TIMEOUT_MS, 60_000))
pruneTimer.unref()

export async function fetchOpenAIWithWebSocket({
  accountKey,
  accessToken,
  input,
  init,
  httpFetch = globalThis.fetch,
}: FetchArgs): Promise<Response> {
  const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url)
  const headers = normalizeHeaders(init?.headers)
  const httpInit = withoutInternalHeaders(init)
  if (!eligible({ url, init, headers })) return httpFetch(input, httpInit)

  const body = parseBody(init?.body)
  if (!body?.stream) return httpFetch(input, httpInit)
  const sessionId =
    headers[OPENAI_WEBSOCKET_SESSION_HEADER] ?? headers['x-session-affinity'] ?? headers['session-id']
  if (!sessionId) return httpFetch(input, httpInit)

  const pool = accountPool({ accountKey, accessToken, endpoint: url.toString() })
  const entry = pool.sessions.get(sessionId) ?? {
    lastUsedAt: Date.now(),
    busy: false,
    fallback: false,
    streamFailures: 0,
  }
  pool.sessions.set(sessionId, entry)
  if (entry.fallback || entry.busy) return httpFetch(input, httpInit)

  entry.busy = true
  entry.lastUsedAt = Date.now()
  const socket = await openSocket({ entry, url, headers, signal: init?.signal }).catch(
    (cause) =>
      errore.isAbortError(cause)
        ? cause
        : new OpenAIWebSocketError({ reason: 'connection failed', cause }),
  )
  if (socket instanceof Error) {
    if (errore.isAbortError(socket)) {
      entry.busy = false
      entry.streamFailures = 0
      invalidate(entry)
      throw socket
    }
    releaseAfterFailure(entry)
    if (entry.fallback) return httpFetch(input, httpInit)
    return new Response(
      new ReadableStream({ start: (controller) => controller.error(socket) }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }

  entry.socket = socket
  const firstEvent = Promise.withResolvers<boolean | WrappedError>()
  const response = streamResponse({
    socket,
    body,
    signal: init?.signal,
    onFirstEvent: (error) => firstEvent.resolve(error ?? true),
    onTerminal: (event) => {
      entry.busy = false
      entry.lastUsedAt = Date.now()
      entry.streamFailures = 0
      if (event.type !== 'response.completed' && event.type !== 'response.done') invalidate(entry)
    },
    onConnectionInvalid: (_error, closeCode) => {
      entry.busy = false
      entry.lastUsedAt = Date.now()
      if (closeCode === MESSAGE_TOO_BIG_CLOSE_CODE) entry.fallback = true
      else recordStreamFailure(entry)
      invalidate(entry)
      firstEvent.resolve(false)
    },
    onAbort: (error) => {
      entry.busy = false
      entry.lastUsedAt = Date.now()
      entry.streamFailures = 0
      invalidate(entry)
      firstEvent.reject(error)
    },
  })
  const first = await firstEvent.promise
  if (first === false) return entry.fallback ? httpFetch(input, httpInit) : response
  if (first === true || first.status < 200 || first.status > 599) return response
  return new Response(first.body, {
    status: first.status,
    headers: { 'content-type': 'application/json', ...first.headers },
  })
}

export function closeOpenAIWebSockets() {
  for (const pool of accountPools.values()) closePool(pool)
  accountPools.clear()
}

function eligible({
  url,
  init,
  headers,
}: {
  url: URL
  init: RequestInit | undefined
  headers: Record<string, string>
}) {
  if (init?.method !== 'POST' || !url.pathname.endsWith('/responses')) return false
  return headers[OPENAI_WEBSOCKET_TITLE_HEADER] !== 'true'
}

function parseBody(body: RequestInit['body']) {
  if (typeof body !== 'string') return undefined
  const parsed = errore.try((): JSONValue => JSON.parse(body))
  if (parsed instanceof Error || !isJSONObject(parsed)) return undefined
  return parsed
}

function accountPool({
  accountKey,
  accessToken,
  endpoint,
}: {
  accountKey: string
  accessToken: string
  endpoint: string
}) {
  const current = accountPools.get(accountKey)
  if (current?.accessToken === accessToken && current.endpoint === endpoint) return current
  if (current) closePool(current)
  const next: AccountPool = { accessToken, endpoint, sessions: new Map() }
  accountPools.set(accountKey, next)
  return next
}

function closePool(pool: AccountPool) {
  for (const entry of pool.sessions.values()) invalidate(entry)
  pool.sessions.clear()
}

function prune() {
  const now = Date.now()
  for (const [accountKey, pool] of accountPools) {
    for (const [sessionId, entry] of pool.sessions) {
      if (entry.busy || now - entry.lastUsedAt < IDLE_TIMEOUT_MS) continue
      invalidate(entry)
      pool.sessions.delete(sessionId)
    }
    if (pool.sessions.size === 0) accountPools.delete(accountKey)
  }
}

async function openSocket({
  entry,
  url,
  headers,
  signal,
}: {
  entry: PoolEntry
  url: URL
  headers: Record<string, string>
  signal?: AbortSignal | null
}) {
  if (
    entry.socket?.readyState === WebSocket.OPEN &&
    entry.connectedAt &&
    Date.now() - entry.connectedAt < MAX_CONNECTION_AGE_MS
  ) {
    return entry.socket
  }

  invalidate(entry)
  const socket = await connect({
    url: url.toString().replace(/^http/, 'ws'),
    headers: normalizeHeaders(withoutInternalHeaders({ headers })?.headers),
    signal: signal ?? undefined,
  })
  entry.connectedAt = Date.now()
  return socket
}

function connect({ url, headers, signal }: { url: string; headers: Record<string, string>; signal?: AbortSignal }) {
  return new Promise<WebSocket>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal))
      return
    }

    const requestHeaders = { ...headers, 'openai-beta': headers['openai-beta'] ?? PROTOCOL_HEADER }
    delete requestHeaders['content-length']
    const socket = new WebSocket(url, { headers: requestHeaders })
    const timeout = setTimeout(() => {
      cleanup()
      terminate(socket)
      reject(new OpenAIWebSocketError({ reason: 'connection timed out' }))
    }, CONNECT_TIMEOUT_MS)

    function cleanup() {
      clearTimeout(timeout)
      socket.off('open', onOpen)
      socket.off('error', onError)
      socket.off('close', onClose)
      signal?.removeEventListener('abort', onAbort)
    }

    function onOpen() {
      cleanup()
      resolve(socket)
    }

    function onError(error: Error) {
      cleanup()
      terminate(socket)
      reject(new OpenAIWebSocketError({ reason: error.message, cause: error }))
    }

    function onClose(code: number, reason: Buffer) {
      cleanup()
      reject(
        new OpenAIWebSocketError({
          reason: closeMessage({ message: 'closed before open', code, reason }),
        }),
      )
    }

    function onAbort() {
      cleanup()
      terminate(socket)
      reject(abortError(signal))
    }

    socket.once('open', onOpen)
    socket.once('error', onError)
    socket.once('close', onClose)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function streamResponse({
  socket,
  body,
  signal,
  onFirstEvent,
  onTerminal,
  onConnectionInvalid,
  onAbort,
}: {
  socket: WebSocket
  body: JSONObject
  signal?: AbortSignal | null
  onFirstEvent: (error?: WrappedError) => void
  onTerminal: (event: JSONObject) => void
  onConnectionInvalid: (error: Error, closeCode?: number) => void
  onAbort: (error: Error) => void
}) {
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let completed = false
  let emitted = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  function cleanup() {
    if (idleTimer) clearTimeout(idleTimer)
    socket.off('message', onMessage)
    socket.off('error', onError)
    socket.off('close', onClose)
    signal?.removeEventListener('abort', handleAbort)
  }

  function invalidateStream(error: Error, closeCode?: number) {
    if (completed) return
    completed = true
    cleanup()
    onConnectionInvalid(error, closeCode)
    controller?.error(error)
  }

  function resetIdleTimeout(message: string) {
    if (completed) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(
      () => invalidateStream(new OpenAIWebSocketError({ reason: message })),
      IDLE_TIMEOUT_MS,
    )
  }

  function onMessage(data: WebSocket.RawData, isBinary: boolean) {
    if (completed) return
    if (isBinary) {
      invalidateStream(new OpenAIWebSocketError({ reason: 'unexpected binary frame' }))
      return
    }

    const text = data.toString()
    const event = errore.try((): JSONValue => JSON.parse(text))
    const record = event instanceof Error || !isJSONObject(event) ? undefined : event
    if (
      record?.type === 'error' &&
      isJSONObject(record.error) &&
      record.error.code === CONNECTION_LIMIT_REACHED_CODE
    ) {
      const reason =
        typeof record.error.message === 'string'
          ? record.error.message
          : CONNECTION_LIMIT_REACHED_CODE
      invalidateStream(new OpenAIWebSocketError({ reason }))
      return
    }

    const wrapped = wrappedError(record, text)
    if (wrapped && record) {
      if (!emitted) onFirstEvent(wrapped)
      completed = true
      cleanup()
      onTerminal(record)
      controller?.error(
        new APICallError({
          message: wrapped.message,
          url: socket.url,
          requestBodyValues: body,
          statusCode: wrapped.status,
          responseHeaders: wrapped.headers,
          responseBody: wrapped.body,
        }),
      )
      return
    }

    if (!emitted) onFirstEvent()
    controller?.enqueue(encoder.encode(`data: ${text.split(/\r?\n/).join('\ndata: ')}\n\n`))
    emitted = true
    resetIdleTimeout('idle timeout waiting for a response')
    if (!record) return

    if (record.type === 'response.completed' || record.type === 'response.done') {
      completed = true
      onTerminal(record)
      cleanup()
      controller?.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller?.close()
      return
    }
    if (record.type === 'response.failed' || record.type === 'response.incomplete' || record.type === 'error') {
      completed = true
      onTerminal(record)
      cleanup()
      controller?.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller?.close()
    }
  }

  function onError(error: Error) {
    invalidateStream(new OpenAIWebSocketError({ reason: error.message, cause: error }))
  }

  function onClose(code: number, reason: Buffer) {
    invalidateStream(
      new OpenAIWebSocketError({
        reason: closeMessage({ message: 'closed before response completed', code, reason }),
      }),
      code,
    )
  }

  function handleAbort() {
    if (completed) return
    completed = true
    cleanup()
    terminate(socket)
    const error = abortError(signal ?? undefined)
    onAbort(error)
    controller?.error(error)
  }

  return new Response(
    new ReadableStream<Uint8Array>({
      start(next) {
        controller = next
        socket.on('message', onMessage)
        socket.once('error', onError)
        socket.once('close', onClose)
        signal?.addEventListener('abort', handleAbort, { once: true })
        if (signal?.aborted) {
          handleAbort()
          return
        }
        const { stream: _stream, background: _background, ...payload } = body
        resetIdleTimeout('idle timeout sending request')
        socket.send(JSON.stringify({ type: 'response.create', ...payload }), (error) => {
          if (completed) return
          resetIdleTimeout('idle timeout waiting for a response')
          if (error) invalidateStream(new OpenAIWebSocketError({ reason: error.message, cause: error }))
        })
      },
      cancel(reason) {
        if (completed) return
        completed = true
        cleanup()
        terminate(socket)
        const error = errore.isAbortError(reason)
          ? reason
          : reason instanceof Error
            ? reason
            : new DOMException(typeof reason === 'string' ? reason : 'Aborted', 'AbortError')
        onAbort(error)
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

function wrappedError(event: JSONObject | undefined, body: string): WrappedError | undefined {
  if (event?.type !== 'error') return undefined
  const status = event.status ?? event.status_code
  if (typeof status !== 'number' || (status >= 200 && status < 300)) return undefined
  return {
    status,
    headers: isJSONObject(event.headers)
      ? Object.fromEntries(
          Object.entries(event.headers).flatMap(([key, value]) =>
            typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
              ? [[key, String(value)]]
              : [],
          ),
        )
      : undefined,
    body,
    message:
      isJSONObject(event.error) && typeof event.error.message === 'string'
        ? event.error.message
        : String(status),
  }
}

function recordStreamFailure(entry: PoolEntry) {
  entry.streamFailures += 1
  if (entry.streamFailures > MAX_STREAM_FAILURES) entry.fallback = true
}

function releaseAfterFailure(entry: PoolEntry) {
  entry.busy = false
  entry.lastUsedAt = Date.now()
  recordStreamFailure(entry)
  invalidate(entry)
}

function invalidate(entry: PoolEntry) {
  if (entry.socket) terminate(entry.socket)
  entry.socket = undefined
  entry.connectedAt = undefined
}

function terminate(socket: WebSocket) {
  socket.on('error', () => {})
  socket.terminate()
}

function normalizeHeaders(headers: RequestInit['headers']) {
  const normalized: Record<string, string> = {}
  new Headers(headers).forEach((value, key) => {
    normalized[key.toLowerCase()] = value
  })
  return normalized
}

function withoutInternalHeaders(init: RequestInit | undefined): RequestInit | undefined {
  if (!init?.headers) return init
  const headers = new Headers(init.headers)
  headers.delete(OPENAI_WEBSOCKET_TITLE_HEADER)
  headers.delete(OPENAI_WEBSOCKET_SESSION_HEADER)
  return { ...init, headers }
}

function abortError(signal: AbortSignal | undefined) {
  if (errore.isAbortError(signal?.reason)) return signal.reason
  return new DOMException(signal?.reason instanceof Error ? signal.reason.message : 'Aborted', 'AbortError')
}

function closeMessage({ message, code, reason }: { message: string; code: number; reason: Buffer }) {
  const details = [`code ${code}`]
  if (code === MESSAGE_TOO_BIG_CLOSE_CODE) details.push('message too big')
  if (reason.length > 0) details.push(reason.toString())
  return `${message} (${details.join(': ')})`
}
