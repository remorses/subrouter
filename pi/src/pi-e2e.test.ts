/** End-to-end Pi test with isolated state and local provider endpoints. */

import { InMemoryCredentialStore, InMemoryModelsStore, type Api, type Model } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import fs from 'node:fs/promises'
import http, { type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { addAccount, loadState, savePreset } from '@subrouter/cli'

type LocalServer = {
  server: Server
  url: string
  requests: Array<{ authorization?: string; body: string; path: string }>
}

type Responder = (request: LocalServer['requests'][number], response: http.ServerResponse) => void

const envNames = [
  'PI_OFFLINE',
  'SUBROUTER_HOME',
  'SUBROUTER_ANTHROPIC_BASE_URL',
  'SUBROUTER_OPENAI_BASE_URL',
  'SUBROUTER_XAI_BASE_URL',
  'SUBROUTER_OPENCODE_BASE_URL',
] as const

function openCodeTestModel(): Model<Api> {
  const provider = builtinProviders().find((entry) => entry.id === 'opencode')
  const model = provider?.getModels().find((entry) => entry.api === 'openai-completions')
  if (!model) throw new Error('Pi has no OpenCode Chat Completions model for the integration test')
  return model
}

async function listen(
  respond: (request: LocalServer['requests'][number], response: http.ServerResponse) => void,
) {
  const requests: LocalServer['requests'] = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += String(chunk)
    })
    request.on('end', () => {
      const received = {
        authorization: request.headers.authorization,
        body,
        path: request.url ?? '',
      }
      requests.push(received)
      respond(received, response)
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Local server has no address')
  return { server, requests, url: `http://127.0.0.1:${address.port}` } satisfies LocalServer
}

function streamChatCompletion({
  response,
  modelId,
  text,
}: {
  response: http.ServerResponse
  modelId: string
  text: string
}) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 1,
      model: modelId,
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    })}\n\n`,
  )
  response.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 1,
      model: modelId,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    })}\n\n`,
  )
  response.end('data: [DONE]\n\n')
}

function streamChatErrorAfterText({
  response,
  modelId,
  text,
}: {
  response: http.ServerResponse
  modelId: string
  text: string
}) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 1,
      model: modelId,
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    })}\n\n`,
  )
  response.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 1,
      model: modelId,
      choices: [{ index: 0, delta: {}, finish_reason: 'rate_limit' }],
    })}\n\n`,
  )
  response.end('data: [DONE]\n\n')
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
}

describe.sequential('@subrouter/pi', () => {
  let root: string
  let projectDir: string
  let agentDir: string
  let subrouterDir: string
  let anthropicServer: LocalServer
  let openCodeServer: LocalServer
  let anthropicRespond: Responder
  let openCodeRespond: Responder
  let savedEnv: Record<string, string | undefined>
  let sessionToDispose: { dispose(): void } | undefined

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'subrouter-pi-'))
    projectDir = path.join(root, 'project')
    agentDir = path.join(root, 'pi-agent')
    subrouterDir = path.join(root, 'subrouter')
    await Promise.all([
      fs.mkdir(projectDir, { recursive: true }),
      fs.mkdir(agentDir, { recursive: true }),
      fs.mkdir(subrouterDir, { recursive: true }),
    ])

    anthropicRespond = (_request, response) => {
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '300' })
      response.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }))
    }
    const model = openCodeTestModel()
    openCodeRespond = (_request, response) => {
      streamChatCompletion({ response, modelId: model.id, text: 'hello from Pi fallback' })
    }
    anthropicServer = await listen((request, response) => anthropicRespond(request, response))
    openCodeServer = await listen((request, response) => openCodeRespond(request, response))

    savedEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]))
    Object.assign(process.env, {
      PI_OFFLINE: '1',
      SUBROUTER_HOME: subrouterDir,
      SUBROUTER_ANTHROPIC_BASE_URL: anthropicServer.url,
      SUBROUTER_OPENAI_BASE_URL: `${root}/blocked-openai`,
      SUBROUTER_XAI_BASE_URL: `${root}/blocked-xai`,
      SUBROUTER_OPENCODE_BASE_URL: `${openCodeServer.url}/v1`,
    })
  })

  afterEach(async () => {
    sessionToDispose?.dispose()
    sessionToDispose = undefined
    await Promise.all([closeServer(anthropicServer.server), closeServer(openCodeServer.server)])
    for (const name of envNames) {
      const value = savedEnv[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await fs.rm(root, { recursive: true, force: true })
  })

  async function createPiSession(preset: string) {
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStore: new InMemoryModelsStore(),
      allowModelNetwork: false,
    })
    const settingsManager = SettingsManager.inMemory(
      { retry: { enabled: false, provider: { maxRetries: 0, maxRetryDelayMs: 1 } } },
      { projectTrusted: false },
    )
    const services = await createAgentSessionServices({
      cwd: projectDir,
      agentDir,
      modelRuntime,
      settingsManager,
      resourceLoaderOptions: {
        additionalExtensionPaths: [path.join(import.meta.dirname, '..', 'dist', 'index.js')],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      },
    })
    expect(services.diagnostics).toEqual([])
    const model = (await services.modelRuntime.getAvailable('subrouter')).find((entry) => entry.id === preset)
    expect(model).toBeTruthy()
    if (!model) throw new Error(`Missing subrouter/${preset}`)

    const created = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(projectDir),
      model,
      thinkingLevel: 'off',
      noTools: 'all',
    })
    sessionToDispose = created.session
    await created.session.bindExtensions({})
    return created.session
  }

  test('loads the built extension and falls through to a native Pi provider', async () => {
    const openCodeModel = openCodeTestModel()
    const anthropicModel = builtinProviders()
      .find((entry) => entry.id === 'anthropic')
      ?.getModels()[0]
    if (!anthropicModel) throw new Error('Pi has no Anthropic model for the integration test')

    await addAccount({
      provider: 'anthropic',
      account: {
        type: 'oauth',
        refresh: 'fake-refresh',
        access: 'sk-ant-oat-fake-access',
        expires: Date.now() + 60 * 60 * 1000,
        email: 'anthropic@example.com',
        addedAt: 1,
        lastUsed: 1,
      },
    })
    await addAccount({
      provider: 'opencode',
      account: { type: 'api', key: 'fake-zen-key', addedAt: 1, lastUsed: 1 },
    })
    await savePreset({
      name: 'integration',
      models: [`anthropic/${anthropicModel.id}`, `opencode/${openCodeModel.id}`],
    })

    const session = await createPiSession('integration')
    await session.prompt('Say hello')

    const assistant = session.messages.findLast((message) => message.role === 'assistant')
    expect(assistant).toMatchObject({
      role: 'assistant',
      provider: 'opencode',
      model: openCodeModel.id,
      stopReason: 'stop',
    })
    expect(assistant?.content).toContainEqual({ type: 'text', text: 'hello from Pi fallback' })
    expect(anthropicServer.requests).toHaveLength(1)
    expect(openCodeServer.requests).toHaveLength(1)
    expect(openCodeServer.requests[0]?.authorization).toBe('Bearer fake-zen-key')
    expect(Object.keys((await loadState()).cooldowns)).toEqual(['anthropic:anthropic@example.com'])
    await expect(fs.access(path.join(agentDir, 'auth.json'))).rejects.toThrow()
  }, 30_000)

  test('cycles accounts and skips the cooled account on the next prompt', async () => {
    const model = openCodeTestModel()
    openCodeRespond = (request, response) => {
      if (request.authorization === 'Bearer account-a') {
        response.writeHead(429, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'rate limit reached' } }))
        return
      }
      streamChatCompletion({ response, modelId: model.id, text: 'account B' })
    }
    await addAccount({
      provider: 'opencode',
      account: { type: 'api', key: 'account-b', addedAt: 1, lastUsed: 1 },
    })
    await addAccount({
      provider: 'opencode',
      account: { type: 'api', key: 'account-a', addedAt: 2, lastUsed: 2 },
    })
    await savePreset({ name: 'accounts', models: [`opencode/${model.id}`] })

    const session = await createPiSession('accounts')
    await session.prompt('first')
    await session.prompt('second')

    expect(openCodeServer.requests.map((request) => request.authorization)).toEqual([
      'Bearer account-a',
      'Bearer account-b',
      'Bearer account-b',
    ])
    expect(Object.keys((await loadState()).cooldowns)).toHaveLength(1)
  }, 30_000)

  test('does not rotate on a normal request error', async () => {
    const model = openCodeTestModel()
    openCodeRespond = (_request, response) => {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'bad request' } }))
    }
    await addAccount({
      provider: 'opencode',
      account: { type: 'api', key: 'fallback-account', addedAt: 1, lastUsed: 1 },
    })
    await addAccount({
      provider: 'opencode',
      account: { type: 'api', key: 'first-account', addedAt: 2, lastUsed: 2 },
    })
    await savePreset({ name: 'bad-request', models: [`opencode/${model.id}`] })

    const session = await createPiSession('bad-request')
    await session.prompt('fail')

    expect(openCodeServer.requests.map((request) => request.authorization)).toEqual(['Bearer first-account'])
    expect(Object.keys((await loadState()).cooldowns)).toEqual([])
  }, 30_000)

  test('does not switch accounts after output starts', async () => {
    const model = openCodeTestModel()
    openCodeRespond = (request, response) => {
      if (request.authorization === 'Bearer first-account') {
        streamChatErrorAfterText({ response, modelId: model.id, text: 'partial answer' })
        return
      }
      streamChatCompletion({ response, modelId: model.id, text: 'duplicate answer' })
    }
    await addAccount({
      provider: 'opencode',
      account: { type: 'api', key: 'fallback-account', addedAt: 1, lastUsed: 1 },
    })
    await addAccount({
      provider: 'opencode',
      account: { type: 'api', key: 'first-account', addedAt: 2, lastUsed: 2 },
    })
    await savePreset({ name: 'partial', models: [`opencode/${model.id}`] })

    const session = await createPiSession('partial')
    await session.prompt('partial')

    expect(openCodeServer.requests.map((request) => request.authorization)).toEqual(['Bearer first-account'])
    const assistant = session.messages.findLast((message) => message.role === 'assistant')
    expect(assistant?.content).toContainEqual({ type: 'text', text: 'partial answer' })
    expect(assistant).toMatchObject({ stopReason: 'error' })
    expect(Object.keys((await loadState()).cooldowns)).toHaveLength(1)
  }, 30_000)
})
