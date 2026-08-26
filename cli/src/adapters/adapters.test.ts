import { APICallError } from '@ai-sdk/provider'
import { describe, expect, test } from 'vitest'
import {
  classifyFailure,
  isPermanentRefreshFailure,
  loadModelsDevCatalog,
  validateModelsDevModelIds,
} from './index.ts'
import { rewriteRequestPayload } from './anthropic.ts'
import { buildOpenAIAuthorizeUrl } from './openai.ts'

function apiError(overrides: { statusCode?: number; responseBody?: string; responseHeaders?: Record<string, string> }) {
  return new APICallError({
    message: `HTTP ${overrides.statusCode}`,
    url: 'https://example.com',
    requestBodyValues: {},
    statusCode: overrides.statusCode,
    responseBody: overrides.responseBody,
    responseHeaders: overrides.responseHeaders,
  })
}

describe('classifyFailure', () => {
  test('429 rotates with retry-after honored', () => {
    const action = classifyFailure(apiError({ statusCode: 429, responseHeaders: { 'retry-after': '600' } }))
    expect(action).toEqual({ rotate: true, cooldownMs: 600_000 })
  })

  test('402 balance exhausted gets a long cooldown', () => {
    const action = classifyFailure(apiError({ statusCode: 402, responseBody: 'Grok Build usage balance exhausted' }))
    expect(action?.rotate).toBe(true)
    expect(action!.cooldownMs).toBeGreaterThanOrEqual(6 * 60 * 60 * 1000)
  })

  test('401/403 rotate, 400 does not', () => {
    expect(classifyFailure(apiError({ statusCode: 401 }))?.rotate).toBe(true)
    expect(classifyFailure(apiError({ statusCode: 403 }))?.rotate).toBe(true)
    expect(classifyFailure(apiError({ statusCode: 400, responseBody: 'bad request' }))).toBeNull()
  })

  test('usage-limit body text rotates even on 200-family errors', () => {
    const action = classifyFailure(apiError({ statusCode: 500, responseBody: 'usage_limit_reached' }))
    expect(action?.rotate).toBe(true)
  })

  test('plain errors with rate limit text rotate', () => {
    expect(classifyFailure(new Error('Rate limit reached for account'))?.rotate).toBe(true)
    expect(classifyFailure(new Error('something else'))).toBeNull()
  })
})

describe('isPermanentRefreshFailure', () => {
  test('detects invalid_grant and expired refresh tokens', () => {
    expect(isPermanentRefreshFailure(new Error('invalid_grant'))).toBe(true)
    expect(isPermanentRefreshFailure(new Error('refresh token expired'))).toBe(true)
    expect(isPermanentRefreshFailure(new Error('network down'))).toBe(false)
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
          'opencode/grok-4.6',
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
