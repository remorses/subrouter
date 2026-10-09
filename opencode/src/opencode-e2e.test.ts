/**
 * End-to-end test: a real OpenCode v2 2.0.2 server drives the subrouter plugin.
 *
 * No real API requests. Fake HTTP servers play the provider endpoints.
 * Prompt is inbox admission in v2, so tests wait on execution events and
 * inspect projected messages. Requires built dist because OpenCode loads
 * dist/index.js and dist/provider.js.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import net from 'node:net'
import { mkdtemp, rm, mkdir, writeFile, readFile, realpath } from 'node:fs/promises'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { OpenCode, type OpenCodeClient, type V2Event } from '@opencode/client'
import {
  addAccount,
  clearCooldowns,
  markCooldown,
  savePreset,
} from '@subrouter/cli'
import { addSubrouterHeaders } from './provider.ts'

type MockServer = {
  url: string
  requests: Array<{ path: string; body: string; headers: Record<string, string> }>
  close: () => Promise<void>
}

type MockHandler = (
  args: { path: string; body: string; headers: Record<string, string> },
  res: import('node:http').ServerResponse,
) => void

async function startMockServer(handler: MockHandler): Promise<MockServer> {
  const requests: MockServer['requests'] = []
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += String(chunk)
    })
    req.on('end', () => {
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers[key] = value
      }
      requests.push({ path: req.url ?? '', body, headers })
      handler({ path: req.url ?? '', body, headers }, res)
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

function resolveOpencode2Command() {
  const require = createRequire(import.meta.url)
  const packageJsonPath = require.resolve('@opencode/cli/package.json')
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    bin?: { opencode2?: string; opencode?: string }
  }
  const binRelative = packageJson.bin?.opencode2 || packageJson.bin?.opencode
  if (typeof binRelative !== 'string') throw new Error('@opencode/cli package.json has no opencode2 bin')
  return path.join(path.dirname(packageJsonPath), binRelative)
}

function getFreePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, () => {
      const address = server.address()
      if (address && typeof address === 'object') {
        const port = address.port
        server.close(() => {
          resolve(port)
        })
        return
      }
      reject(new Error('Failed to get free port'))
    })
    server.on('error', reject)
  })
}

function basicAuth(password: string) {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
}

async function startOpencode2Server({
  home,
  projectDir,
}: {
  home: string
  projectDir: string
}) {
  const port = await getFreePort()
  const password = randomBytes(32).toString('base64url')
  const baseUrl = `http://127.0.0.1:${port}`
  const isolationHome = path.join(home, 'opencode-home')
  const isolation = {
    HOME: isolationHome,
    USERPROFILE: isolationHome,
    OPENCODE_TEST_HOME: isolationHome,
    XDG_CONFIG_HOME: path.join(isolationHome, '.config'),
    XDG_DATA_HOME: path.join(isolationHome, '.local', 'share'),
    XDG_CACHE_HOME: path.join(isolationHome, '.cache'),
    XDG_STATE_HOME: path.join(isolationHome, '.local', 'state'),
    OPENCODE_CONFIG_DIR: path.join(isolationHome, '.config', 'opencode'),
  }
  for (const directory of Object.values(isolation)) {
    await mkdir(directory, { recursive: true })
  }
  const env = {
    ...process.env,
    ...isolation,
    OPENCODE_PASSWORD: password,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
  } satisfies NodeJS.ProcessEnv
  Reflect.deleteProperty(env, 'OPENCODE_CONFIG')
  Reflect.deleteProperty(env, 'OPENCODE_CONFIG_CONTENT')
  Reflect.deleteProperty(env, 'OPENCODE_SERVER_PASSWORD')
  const child: ChildProcess = spawn(
    resolveOpencode2Command(),
    ['serve', '--port', String(port), '--hostname', '127.0.0.1'],
    {
      cwd: projectDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    },
  )
  const stderr: string[] = []
  child.stderr?.on('data', (chunk) => {
    stderr.push(String(chunk))
  })
  for (let attempt = 0; attempt < 300; attempt++) {
    const response = await fetch(`${baseUrl}/api/session/active`, {
      headers: { authorization: basicAuth(password) },
      signal: AbortSignal.timeout(2000),
    }).catch(() => null)
    if (response?.status === 200) {
      return {
        baseUrl,
        password,
        stderr,
        close: () => {
          if (!child.killed) child.kill('SIGTERM')
        },
      }
    }
    if (response?.status === 401 || response?.status === 403) {
      child.kill('SIGTERM')
      throw new Error(`opencode2 rejected credentials: ${response.status}\n${stderr.join('')}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  child.kill('SIGTERM')
  throw new Error(`opencode2 did not become ready\n${stderr.join('')}`)
}

function eventSessionId(event: V2Event) {
  const data = event.data
  if (!Object.hasOwn(data, 'sessionID')) return undefined
  const sessionID = Reflect.get(data, 'sessionID')
  return typeof sessionID === 'string' ? sessionID : undefined
}

function assistantText(messages: Awaited<ReturnType<OpenCodeClient['message']['list']>>) {
  return messages.data
    .flatMap((message) => {
      if (message.type !== 'assistant') return []
      return message.content.flatMap((part) => {
        if (part.type === 'text') return [part.text]
        return []
      })
    })
    .join('\n')
}

let home: string
let projectDir: string
let anthropicMock: MockServer
let modelsDevMock: MockServer
let zenMock: MockServer
let openaiMock: MockServer
let zenRespond: MockHandler
let defaultZenRespond: MockHandler
let openaiRespond: MockHandler
let defaultOpenaiRespond: MockHandler
let server: { baseUrl: string; password: string; stderr: string[]; close: () => void }
let client: OpenCodeClient
const events: V2Event[] = []
const createdSessionIds: string[] = []
const subscribeController = new AbortController()
const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), 'subrouter-e2e-')))
  projectDir = path.join(home, 'project')
  await mkdir(projectDir, { recursive: true })

  anthropicMock = await startMockServer((_request, res) => {
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }))
  })

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
        choices: [{ index: 0, delta: { role: 'assistant', content: 'hello from fallback' }, finish_reason: null }],
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

  defaultOpenaiRespond = (_request, res) => {
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
  }
  openaiRespond = defaultOpenaiRespond
  openaiMock = await startMockServer((request, response) => openaiRespond(request, response))

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

  const subrouterHome = path.join(home, 'subrouter')
  await mkdir(subrouterHome, { recursive: true })
  for (const [key, value] of Object.entries({
    SUBROUTER_HOME: subrouterHome,
    SUBROUTER_ANTHROPIC_BASE_URL: `${anthropicMock.url}/v1`,
    SUBROUTER_MODELS_DEV_URL: modelsDevMock.url,
    SUBROUTER_OPENCODE_GO_BASE_URL: `${zenMock.url}/v1`,
    SUBROUTER_OPENAI_BASE_URL: openaiMock.url,
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
  await savePreset({ name: 'gpt-openai-only', models: ['openai/gpt-5.5'] })

  const pluginDirectory = path.join(import.meta.dirname, '..', 'dist')
  await writeFile(
    path.join(projectDir, 'opencode.json'),
    JSON.stringify(
      {
        plugins: [pluginDirectory],
        model: 'subrouter/default',
        permissions: [
          { action: '*', resource: '*', effect: 'allow' },
        ],
      },
      null,
      2,
    ),
  )

  server = await startOpencode2Server({ home, projectDir })
  client = OpenCode.make({
    baseUrl: server.baseUrl,
    headers: {
      authorization: basicAuth(server.password),
      'x-opencode-directory': projectDir,
    },
  })
  void (async () => {
    try {
      for await (const event of client.event.subscribe({ signal: subscribeController.signal })) {
        events.push(event)
      }
    } catch {
      // aborted during teardown
    }
  })()
  await client.plugin.awaitActivation({ location: { directory: projectDir } })
}, 120_000)

afterEach(() => {
  zenRespond = defaultZenRespond
  openaiRespond = defaultOpenaiRespond
})

afterAll(async () => {
  for (const sessionID of createdSessionIds) {
    await client?.session.remove({ sessionID }).catch(() => undefined)
  }
  subscribeController.abort()
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

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 30_000, label = 'condition' }: { timeoutMs?: number; label?: string } = {},
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(
    `Timed out waiting for ${label}. Event types: ${events.map((event) => event.type).join(', ')}\nstderr:\n${server.stderr.slice(-20).join('')}`,
  )
}

function executionEnded(sessionID: string) {
  return events.some((event) => {
    return (
      (event.type === 'session.execution.succeeded' ||
        event.type === 'session.execution.failed' ||
        event.type === 'session.execution.interrupted') &&
      eventSessionId(event) === sessionID
    )
  })
}

async function promptUntilIdle({
  title,
  text,
  model,
}: {
  title: string
  text: string
  model?: { providerID: string; id: string }
}) {
  const session = await client.session.create({
    title,
    location: { directory: projectDir },
    model,
  })
  createdSessionIds.push(session.id)
  await client.session.prompt({ sessionID: session.id, text })
  await waitFor(() => executionEnded(session.id), { label: `execution end for ${session.id}` })
  const messages = await client.message.list({ sessionID: session.id })
  return { session, messages }
}

describe('opencode v2 + subrouter plugin', () => {
  test('adds session affinity headers for primary requests only', () => {
    const headers: Record<string, string> = {}
    addSubrouterHeaders({
      sessionID: 'session-1',
      agent: 'build',
      kind: 'primary',
      model: { providerID: 'subrouter', id: 'build', variant: 'high' },
      headers,
    })
    expect(headers['x-subrouter-route-affinity']).toBe('session-1')
    expect(headers['x-subrouter-opencode-agent']).toBe('build')
    expect(headers['x-subrouter-session-id']).toBe('session-1')
  })

  test('plugin is active and catalogs subrouter models', async () => {
    const listed = await client.plugin.list({ location: { directory: projectDir } })
    expect(listed.data.find((item) => item.id === 'subrouter')).toMatchObject({
      id: 'subrouter',
      state: { status: 'active' },
    })
    const models = await client.model.list({ location: { directory: projectDir } })
    const ids = models.data.map((model) => `${model.providerID}/${model.id}`)
    expect(ids).toContain('subrouter/default')
    expect(ids).toContain('subrouter/openai-only')
  })

  test('rate-limited Anthropic is cycled to OpenCode Go', async () => {
    const { messages } = await promptUntilIdle({
      title: 'subrouter e2e',
      text: 'say hi',
      model: { providerID: 'subrouter', id: 'default' },
    })
    expect(assistantText(messages)).toContain('hello from fallback')
    expect(anthropicMock.requests.length).toBeGreaterThan(0)
    expect(zenMock.requests.length).toBeGreaterThan(0)
  }, 120_000)

  test('keeps the fallback candidate through tool follow-ups, then resets on the next execution', async () => {
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
    zenRespond = async ({ body }, res) => {
      fallbackBodies.push(body)
      fallbackCalls++
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (fallbackCalls === 1) {
        await clearCooldowns()
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

    const session = await client.session.create({
      title: 'subrouter tool affinity',
      location: { directory: projectDir },
      model: { providerID: 'subrouter', id: 'default' },
    })
    createdSessionIds.push(session.id)
    const anthropicBefore = anthropicMock.requests.length
    await client.session.prompt({ sessionID: session.id, text: 'read the file' })
    await waitFor(() => executionEnded(session.id), { label: 'tool affinity first execution' })
    expect(anthropicMock.requests).toHaveLength(anthropicBefore)
    expect(fallbackCalls).toBeGreaterThanOrEqual(2)
    expect(anthropicMock.requests).toHaveLength(anthropicBefore)

    await clearCooldowns()
    await client.session.prompt({ sessionID: session.id, text: 'say done' })
    await waitFor(
      () =>
        events.filter(
          (event) => event.type === 'session.execution.succeeded' && eventSessionId(event) === session.id,
        ).length >= 2,
      { label: 'tool affinity second execution' },
    )
    expect(anthropicMock.requests).toHaveLength(anthropicBefore + 1)
    expect(fallbackCalls).toBeGreaterThanOrEqual(3)
  }, 120_000)

  test('openai presets keep the v2 file editing tools available', async () => {
    const { messages } = await promptUntilIdle({
      title: 'subrouter apply_patch',
      text: 'say hi',
      model: { providerID: 'subrouter', id: 'openai-only' },
    })
    expect(assistantText(messages)).toContain('hello from openai')
    expect(openaiMock.requests.length).toBeGreaterThan(0)
    const raw = openaiMock.requests.at(-1)!.body
    const body = JSON.parse(raw) as {
      tools?: Array<{ name?: string; type?: string; function?: { name?: string } }>
      store?: boolean
      include?: string[]
    }
    const toolNames = (body.tools ?? []).map((tool) => tool.name ?? tool.function?.name)
    expect(toolNames).not.toContain('patch')
    expect(toolNames).toContain('edit')
    expect(toolNames).toContain('write')
    expect(body.store).toBe(false)
    expect(body.include).toEqual(expect.arrayContaining(['reasoning.encrypted_content']))
  }, 120_000)

  test('gpt- preset names opt into the v2 patch tool', async () => {
    const { messages } = await promptUntilIdle({
      title: 'subrouter patch marker',
      text: 'say hi',
      model: { providerID: 'subrouter', id: 'gpt-openai-only' },
    })
    expect(assistantText(messages)).toContain('hello from openai')
    const raw = openaiMock.requests.at(-1)!.body
    const body = JSON.parse(raw) as {
      tools?: Array<{ name?: string; function?: { name?: string } }>
    }
    const toolNames = (body.tools ?? []).map((tool) => tool.name ?? tool.function?.name)
    expect(toolNames).toContain('patch')
    expect(toolNames).not.toContain('edit')
    expect(toolNames).not.toContain('write')
  }, 120_000)

  test('openai follow-up keeps store:false and encrypted reasoning', async () => {
    const session = await client.session.create({
      title: 'subrouter openai followup',
      location: { directory: projectDir },
      model: { providerID: 'subrouter', id: 'openai-only' },
    })
    createdSessionIds.push(session.id)
    await client.session.prompt({ sessionID: session.id, text: 'say hi' })
    await waitFor(() => executionEnded(session.id), { label: 'openai first execution' })
    await client.session.prompt({ sessionID: session.id, text: 'say hi again' })
    await waitFor(
      () =>
        events.filter(
          (event) => event.type === 'session.execution.succeeded' && eventSessionId(event) === session.id,
        ).length >= 2,
      { label: 'openai second execution' },
    )
    const followUp = openaiMock.requests.at(-1)
    expect(followUp).toBeTruthy()
    const body = JSON.parse(followUp!.body) as { store?: boolean; include?: string[] }
    expect(body.store).toBe(false)
    expect(body.include).toEqual(expect.arrayContaining(['reasoning.encrypted_content']))
  }, 120_000)
})
