import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  classifyFailure,
  isPermanentRefreshFailure,
  loadModelsDevCatalog,
  modelsDevLimit,
  parseModelsDevCatalog,
  validateModelsDevModelIds,
} from './index.ts'
import { rewriteRequestPayload } from './anthropic.ts'
import {
  buildGitHubDeviceCodeBody,
  buildCopilotTokenRequest,
  patchCopilotBody,
  shouldUseCopilotResponses,
} from './github-copilot.ts'
import { buildOpenAIAuthorizeUrl, patchCodexBody, withCodexProviderOptions } from './openai.ts'
import { buildPoeAuthorizeUrl, parsePoeCallbackInput } from './poe.ts'

describe('classifyFailure', () => {
  test('429 rotates with retry-after honored', () => {
    const action = classifyFailure({ statusCode: 429, headers: { 'retry-after': '600' }, message: 'rate limited' })
    expect(action).toEqual({ rotate: true, cooldownMs: 600_000 })
  })

  test('402 balance exhausted gets a long cooldown', () => {
    const action = classifyFailure({ statusCode: 402, body: 'Grok Build usage balance exhausted', message: 'exhausted' })
    expect(action?.rotate).toBe(true)
    expect(action!.cooldownMs).toBeGreaterThanOrEqual(6 * 60 * 60 * 1000)
  })

  test('401/403 rotate, 400 does not', () => {
    expect(classifyFailure({ statusCode: 401, message: 'unauthorized' })?.rotate).toBe(true)
    expect(classifyFailure({ statusCode: 403, message: 'forbidden' })?.rotate).toBe(true)
    expect(classifyFailure({ statusCode: 400, body: 'bad request', message: 'bad request' })).toBeNull()
  })

  test('usage-limit body text rotates even on 200-family errors', () => {
    const action = classifyFailure({ statusCode: 500, body: 'usage_limit_reached', message: 'server error' })
    expect(action?.rotate).toBe(true)
  })

  test('plain errors with rate limit text rotate', () => {
    expect(classifyFailure({ message: 'Rate limit reached for account' })?.rotate).toBe(true)
    expect(classifyFailure({ message: 'refresh token expired, re-login required' })?.rotate).toBe(true)
    const quota = classifyFailure({ message: 'Your 1-week quota has been exhausted' })
    expect(quota?.rotate).toBe(true)
    expect(quota!.cooldownMs).toBeGreaterThanOrEqual(6 * 60 * 60 * 1000)
    expect(classifyFailure({ message: 'something else' })).toBeNull()
  })
})

describe('isPermanentRefreshFailure', () => {
  test('detects invalid_grant and expired refresh tokens', () => {
    expect(isPermanentRefreshFailure(new Error('invalid_grant'))).toBe(true)
    expect(isPermanentRefreshFailure(new Error('refresh token expired'))).toBe(true)
    expect(isPermanentRefreshFailure(new Error('network down'))).toBe(false)
  })
})

describe('models.dev validation', () => {
  const emptyProvider = { models: {} }
  const payload = {
    anthropic: emptyProvider,
    openai: {
      models: {
        'text-only': { id: 'text-only', modalities: { output: ['text'] } },
        multimodal: { id: 'multimodal', modalities: { output: ['image', 'text'] } },
        'image-only': { id: 'image-only', modalities: { output: ['image'] } },
        'audio-only': { id: 'audio-only', modalities: { output: ['audio'] } },
        'video-only': { id: 'video-only', modalities: { output: ['video'] } },
        'unknown-output': { id: 'unknown-output' },
      },
    },
    xai: emptyProvider,
    'opencode-go': emptyProvider,
    'github-copilot': emptyProvider,
    poe: emptyProvider,
    'minimax-coding-plan': emptyProvider,
    'kimi-for-coding': emptyProvider,
    'zai-coding-plan': emptyProvider,
    'alibaba-coding-plan': emptyProvider,
  }

  test('keeps only models with text output', () => {
    const catalog = parseModelsDevCatalog(payload)
    expect(catalog).not.toBeInstanceOf(Error)
    if (catalog instanceof Error) return

    expect([...catalog.openai.keys()]).toEqual(['text-only', 'multimodal'])
    expect(
      validateModelsDevModelIds({
        entries: ['openai/text-only', 'openai/multimodal'],
        catalog,
      }),
    ).toBeNull()
    expect(
      [
        'openai/image-only',
        'openai/audio-only',
        'openai/video-only',
        'openai/unknown-output',
        'openai/not-in-catalog',
        'openai/',
      ].map((entry) => validateModelsDevModelIds({ entries: [entry], catalog })),
    ).toMatchInlineSnapshot(`
      [
        [InvalidModelError: Model openai/image-only is not available as a text-output language model in models.dev],
        [InvalidModelError: Model openai/audio-only is not available as a text-output language model in models.dev],
        [InvalidModelError: Model openai/video-only is not available as a text-output language model in models.dev],
        [InvalidModelError: Model openai/unknown-output is not available as a text-output language model in models.dev],
        [InvalidModelError: Model openai/not-in-catalog is not available as a text-output language model in models.dev],
        [InvalidModelError: Model openai/ is not available as a text-output language model in models.dev],
      ]
    `)
  })

  test('accepts opencode-go text models', () => {
    const catalog = parseModelsDevCatalog({
      ...payload,
      'opencode-go': {
        models: {
          'glm-5.3-flash': { id: 'glm-5.3-flash', modalities: { output: ['text'] } },
        },
      },
    })
    expect(catalog).not.toBeInstanceOf(Error)
    if (catalog instanceof Error) return
    expect(
      validateModelsDevModelIds({ entries: ['opencode-go/glm-5.3-flash'], catalog }),
    ).toBeNull()
  })

  test('looks up context and output limits for a text model', () => {
    const catalog = parseModelsDevCatalog({
      ...payload,
      openai: {
        models: {
          'text-only': {
            id: 'text-only',
            modalities: { output: ['text'] },
            limit: { context: 400_000, output: 32_000 },
          },
        },
      },
    })
    expect(catalog).not.toBeInstanceOf(Error)
    if (catalog instanceof Error) return

    expect(
      modelsDevLimit({ provider: 'openai', modelId: 'text-only', catalog }),
    ).toEqual({ context: 400_000, output: 32_000 })
    expect(modelsDevLimit({ provider: 'openai', modelId: 'missing', catalog })).toBeNull()
    expect(
      modelsDevLimit({ provider: 'openai', modelId: 'text-only', catalog: new Error('offline') }),
    ).toBeNull()
  })

  test('caches the catalog and reuses it when models.dev is unreachable', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'subrouter-catalog-'))
    const previousHome = process.env.SUBROUTER_HOME
    const previousUrl = process.env.SUBROUTER_MODELS_DEV_URL
    process.env.SUBROUTER_HOME = home
    let hits = 0
    const server = createServer((_req, res) => {
      hits += 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          ...payload,
          openai: {
            models: {
              'text-only': {
                id: 'text-only',
                modalities: { output: ['text'] },
                limit: { context: 400_000, output: 32_000 },
              },
            },
          },
        }),
      )
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (typeof address === 'string' || !address) throw new Error('failed to bind fake models.dev')
    process.env.SUBROUTER_MODELS_DEV_URL = `http://127.0.0.1:${address.port}`

    try {
      const first = await loadModelsDevCatalog()
      const second = await loadModelsDevCatalog()
      expect(first).not.toBeInstanceOf(Error)
      expect(second).not.toBeInstanceOf(Error)
      expect(hits).toBe(1)

      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
      const third = await loadModelsDevCatalog()
      expect(third).not.toBeInstanceOf(Error)
      if (third instanceof Error) return
      expect(modelsDevLimit({ provider: 'openai', modelId: 'text-only', catalog: third })).toEqual({
        context: 400_000,
        output: 32_000,
      })
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
      if (previousHome === undefined) delete process.env.SUBROUTER_HOME
      else process.env.SUBROUTER_HOME = previousHome
      if (previousUrl === undefined) delete process.env.SUBROUTER_MODELS_DEV_URL
      else process.env.SUBROUTER_MODELS_DEV_URL = previousUrl
      await rm(home, { recursive: true, force: true })
    }
  })

  test('refetches models.dev when the cache is older than one hour', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'subrouter-catalog-stale-'))
    const previousHome = process.env.SUBROUTER_HOME
    const previousUrl = process.env.SUBROUTER_MODELS_DEV_URL
    process.env.SUBROUTER_HOME = home
    let hits = 0
    const server = createServer((_req, res) => {
      hits += 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          ...payload,
          openai: {
            models: {
              'text-only': {
                id: 'text-only',
                modalities: { output: ['text'] },
                limit: { context: 800_000, output: 64_000 },
              },
            },
          },
        }),
      )
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (typeof address === 'string' || !address) throw new Error('failed to bind fake models.dev')
    const url = `http://127.0.0.1:${address.port}`
    process.env.SUBROUTER_MODELS_DEV_URL = url
    await writeFile(
      path.join(home, 'models-dev.json'),
      JSON.stringify({
        fetchedAt: Date.now() - 61 * 60 * 1000,
        url,
        payload: {
          ...payload,
          openai: {
            models: {
              'text-only': {
                id: 'text-only',
                modalities: { output: ['text'] },
                limit: { context: 400_000, output: 32_000 },
              },
            },
          },
        },
      }),
    )

    try {
      const catalog = await loadModelsDevCatalog()
      expect(catalog).not.toBeInstanceOf(Error)
      expect(hits).toBe(1)
      if (catalog instanceof Error) return
      expect(modelsDevLimit({ provider: 'openai', modelId: 'text-only', catalog })).toEqual({
        context: 800_000,
        output: 64_000,
      })
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
      if (previousHome === undefined) delete process.env.SUBROUTER_HOME
      else process.env.SUBROUTER_HOME = previousHome
      if (previousUrl === undefined) delete process.env.SUBROUTER_MODELS_DEV_URL
      else process.env.SUBROUTER_MODELS_DEV_URL = previousUrl
      await rm(home, { recursive: true, force: true })
    }
  })

  test('rejects malformed model records clearly', () => {
    const malformedPayload = {
      ...payload,
      openai: { models: { broken: { modalities: { output: ['text'] } } } },
    }
    expect(parseModelsDevCatalog(malformedPayload)).toMatchInlineSnapshot(`[ModelsDevError: Could not load model IDs from models.dev: invalid response shape]`)
  })
})

describe('OpenAI browser auth', () => {
  test('builds the Codex PKCE authorization URL', () => {
    const url = new URL(
      buildOpenAIAuthorizeUrl({
        redirectUri: 'http://localhost:1455/auth/callback',
        challenge: 'pkce-challenge',
        state: 'oauth-state',
      }),
    )
    expect(Object.fromEntries(url.searchParams)).toMatchInlineSnapshot(`
      {
        "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
        "code_challenge": "pkce-challenge",
        "code_challenge_method": "S256",
        "codex_cli_simplified_flow": "true",
        "id_token_add_organizations": "true",
        "originator": "opencode",
        "redirect_uri": "http://localhost:1455/auth/callback",
        "response_type": "code",
        "scope": "openid profile email offline_access",
        "state": "oauth-state",
      }
    `)
  })
})

describe('GitHub Copilot', () => {
  test('builds the GitHub device request and selects the Responses API', () => {
    expect(Object.fromEntries(new URLSearchParams(buildGitHubDeviceCodeBody()))).toMatchInlineSnapshot(`
      {
        "client_id": "Iv1.b507a08c87ecfe98",
        "scope": "read:user",
      }
    `)
    expect(shouldUseCopilotResponses('gpt-5.5')).toBe(true)
    expect(shouldUseCopilotResponses('gpt-5-mini')).toBe(true)
    expect(shouldUseCopilotResponses('grok-4.6')).toBe(true)
    expect(shouldUseCopilotResponses('claude-opus-5')).toBe(false)
    const tokenRequest = buildCopilotTokenRequest('github-token')
    expect(tokenRequest.method).toBeUndefined()
    expect(Object.fromEntries(new Headers(tokenRequest.headers))).toMatchInlineSnapshot(`
      {
        "accept": "application/json",
        "authorization": "Bearer github-token",
        "copilot-integration-id": "vscode-chat",
        "editor-plugin-version": "copilot-chat/0.35.0",
        "editor-version": "vscode/1.107.0",
        "user-agent": "GitHubCopilotChat/0.35.0",
      }
    `)
  })

  test('removes the tool field rejected by the Copilot Anthropic endpoint', () => {
    expect(
      JSON.parse(
        patchCopilotBody(
          JSON.stringify({
            tools: [{ name: 'bash', eager_input_streaming: true }, { name: 'read' }],
          }),
        )!,
      ),
    ).toMatchInlineSnapshot(`
      {
        "tools": [
          {
            "name": "bash",
          },
          {
            "name": "read",
          },
        ],
      }
    `)
  })
})

describe('Poe OAuth', () => {
  test('builds the PKCE authorization URL and parses the callback', () => {
    const url = new URL(
      buildPoeAuthorizeUrl({
        redirectUri: 'http://127.0.0.1:1234/callback',
        challenge: 'pkce-challenge',
        state: 'oauth-state',
      }),
    )
    expect(Object.fromEntries(url.searchParams)).toMatchInlineSnapshot(`
      {
        "client_id": "client_728290227fc048cc9262091a1ea197ea",
        "code_challenge": "pkce-challenge",
        "code_challenge_method": "S256",
        "redirect_uri": "http://127.0.0.1:1234/callback",
        "response_type": "code",
        "scope": "apikey:create",
        "state": "oauth-state",
      }
    `)
    expect(
      parsePoeCallbackInput({
        input: 'http://127.0.0.1:1234/callback?code=poe-code&state=oauth-state',
        state: 'oauth-state',
      }),
    ).toBe('poe-code')
  })
})

describe.skipIf(!process.env.TEST_MODELS_DEV)('models.dev validation', () => {
  test('accepts current models and rejects unknown model IDs', async () => {
    const catalog = await loadModelsDevCatalog()
    expect(catalog).not.toBeInstanceOf(Error)
    if (catalog instanceof Error) return

    expect(
      validateModelsDevModelIds({
        entries: [
          'anthropic/claude-opus-4-6',
          'openai/gpt-5.5',
          'xai/grok-4.6',
          'opencode-go/glm-5.3-flash',
          'minimax/MiniMax-M3',
          'kimi/k3',
          'zai/glm-5.3',
          'alibaba/qwen3.7-plus',
        ],
        catalog,
      }),
    ).toBeNull()
    expect(
      validateModelsDevModelIds({ entries: ['openai/not-a-real-model'], catalog }),
    ).toMatchInlineSnapshot(`[InvalidModelError: Model not-a-real-model does not exist for provider openai in models.dev]`)
  })
})

describe('anthropic request rewriting', () => {
  test('renames tools, prepends Claude Code identity, keeps reverse map', () => {
    const body = JSON.stringify({
      model: 'claude-opus-4-6',
      system: 'You are OpenCode, the best coding agent on the planet.\n<env>\nWorking directory: /tmp/proj\n</env>\nrest',
      tools: [{ name: 'bash' }, { name: 'custom_tool' }],
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', name: 'bash', id: '1', input: {} }] },
      ],
    })
    const result = rewriteRequestPayload(body)
    const payload = JSON.parse(result.body!)
    expect(payload.tools.map((t: { name: string }) => t.name)).toEqual(['Bash', 'custom_tool'])
    expect(payload.system[0]).toEqual({
      type: 'text',
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
    })
    expect(payload.system[1].text).toContain('<cwd>/tmp/proj</cwd>')
    expect(payload.messages[0].content[0].name).toBe('Bash')
    expect(result.reverseToolNameMap.get('Bash')).toBe('bash')
    expect(result.modelId).toBe('claude-opus-4-6')
  })
})

describe('patchCodexBody', () => {
  test('forces store false, drops max_output_tokens, asks for encrypted reasoning', () => {
    const patched = JSON.parse(
      patchCodexBody(
        JSON.stringify({
          model: 'gpt-5.6-sol',
          store: true,
          max_output_tokens: 32000,
          include: ['file_search_call.results'],
        }),
      )!,
    )
    expect(patched.store).toBe(false)
    expect(patched.max_output_tokens).toBeUndefined()
    expect(patched.include).toEqual(['file_search_call.results', 'reasoning.encrypted_content'])
  })

  test('strips stored item ids and drops reasoning without encrypted content', () => {
    const patched = JSON.parse(
      patchCodexBody(
        JSON.stringify({
          model: 'gpt-5.6-sol',
          input: [
            { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
            { type: 'reasoning', id: 'rs_dead', summary: [] },
            {
              type: 'reasoning',
              id: 'rs_keep',
              summary: [],
              encrypted_content: 'enc',
            },
            {
              type: 'function_call',
              id: 'fc_dead',
              call_id: 'call_1',
              name: 'bash',
              arguments: '{}',
            },
            { type: 'item_reference', id: 'fc_keep' },
          ],
        }),
      )!,
    )
    expect(patched.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'reasoning', summary: [], encrypted_content: 'enc' },
      { type: 'function_call', call_id: 'call_1', name: 'bash', arguments: '{}' },
      { type: 'item_reference', id: 'fc_keep' },
    ])
  })

  test('withCodexProviderOptions forces store false for the AI SDK', () => {
    expect(withCodexProviderOptions({ providerOptions: { openai: { store: true } } })).toEqual({
      providerOptions: { openai: { store: false } },
    })
  })
})
