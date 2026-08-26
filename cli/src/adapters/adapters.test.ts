import { describe, expect, test } from 'vitest'
import {
  classifyFailure,
  isPermanentRefreshFailure,
  loadModelsDevCatalog,
  validateModelsDevModelIds,
} from './index.ts'
import { rewriteRequestPayload } from './anthropic.ts'
import { buildOpenAIAuthorizeUrl } from './openai.ts'

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
