/**
 * Login flow tests. Adapters expose beginLogin/complete so harnesses that
 * cannot block on a TTY (opencode's auth hook) can show the URL first and
 * finish later. No real API calls: the openai device flow points at a local
 * fake through SUBROUTER_OPENAI_ISSUER_URL.
 */

import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, test } from 'vitest'
import { anthropicAdapter } from './anthropic.ts'
import { alibabaAdapter, kimiAdapter, minimaxAdapter, zaiAdapter } from './coding-plans.ts'
import { openaiAdapter } from './openai.ts'
import { opencodeAdapter } from './opencode.ts'
import { poeAdapter } from './poe.ts'

/** Same regex harnesses use to pull a device code out of `instructions`. */
const DEVICE_CODE_PATTERN = /code:\s*([A-Z0-9][A-Z0-9-]+)/

function jwt(claims: { email: string; chatgpt_account_id: string }) {
  const part = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `header.${part}.signature`
}

async function startFakeIssuer({ pendingPolls }: { pendingPolls: number }) {
  let polls = 0
  const server = createServer((req, res) => {
    const url = new URL(req.url || '', 'http://localhost')
    const send = (status: number, body: Record<string, string | number>) => {
      res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' })
      res.end(JSON.stringify(body))
    }

    if (url.pathname === '/api/accounts/deviceauth/usercode') {
      send(200, { device_auth_id: 'dev-1', user_code: 'WXYZ-1234', interval: '0' })
      return
    }
    if (url.pathname === '/api/accounts/deviceauth/token') {
      polls++
      if (polls <= pendingPolls) {
        send(404, { error: 'authorization_pending' })
        return
      }
      send(200, { authorization_code: 'auth-code', code_verifier: 'verifier' })
      return
    }
    if (url.pathname === '/oauth/token') {
      send(200, {
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3600,
        id_token: jwt({ email: 'Someone@Example.com', chatgpt_account_id: 'acct-1' }),
      })
      return
    }
    send(404, { error: 'not found' })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (typeof address === 'string' || !address) throw new Error('failed to bind fake issuer')
  return { server, url: `http://127.0.0.1:${address.port}`, pollCount: () => polls }
}

const openServers: Server[] = []

afterEach(async () => {
  delete process.env.SUBROUTER_OPENAI_ISSUER_URL
  for (const server of openServers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  }
})

describe('openai device flow', () => {
  test('beginLogin surfaces a parseable device code, complete exchanges tokens', async () => {
    // pendingPolls stays 0: the retry loop is unchanged pre-existing code and
    // sleeps interval + 3s safety margin, which would make this test crawl.
    const issuer = await startFakeIssuer({ pendingPolls: 0 })
    openServers.push(issuer.server)
    process.env.SUBROUTER_OPENAI_ISSUER_URL = issuer.url

    const session = await openaiAdapter.beginLogin({ method: 'device' })
    if (session instanceof Error) throw session

    expect(session.method).toBe('auto')
    expect(session.url).toBe(`${issuer.url}/codex/device`)
    expect(session.instructions.match(DEVICE_CODE_PATTERN)?.[1]).toBe('WXYZ-1234')

    const account = await session.complete()
    if (account instanceof Error) throw account

    expect(account).toMatchObject({
      type: 'oauth',
      access: 'access-1',
      refresh: 'refresh-1',
      email: 'Someone@Example.com',
      accountId: 'acct-1',
    })
    expect(issuer.pollCount()).toBe(1)
  })

  test('complete is memoized so a retrying harness does not start a second poll', async () => {
    const issuer = await startFakeIssuer({ pendingPolls: 0 })
    openServers.push(issuer.server)
    process.env.SUBROUTER_OPENAI_ISSUER_URL = issuer.url

    const session = await openaiAdapter.beginLogin({ method: 'device' })
    if (session instanceof Error) throw session

    const [first, second] = await Promise.all([session.complete(), session.complete()])
    expect(first).toBe(second)
    expect(issuer.pollCount()).toBe(1)
  })
})

describe('opencode zen login', () => {
  test('asks for a pasted key and trims it', async () => {
    const session = await opencodeAdapter.beginLogin()
    if (session instanceof Error) throw session

    expect(session.method).toBe('code')
    const account = await session.complete('  zen-key-1  ')
    expect(account).toMatchObject({ type: 'api', key: 'zen-key-1' })
  })

  test('rejects an empty key instead of storing a blank account', async () => {
    const session = await opencodeAdapter.beginLogin()
    if (session instanceof Error) throw session

    expect(await session.complete()).toBeInstanceOf(Error)
    expect(await session.complete('   ')).toBeInstanceOf(Error)
  })
})

describe('Poe login', () => {
  test('manual login does not wait on a local callback without pasted input', async () => {
    const session = await poeAdapter.beginLogin({ manualInput: true })
    if (session instanceof Error) throw session

    expect(session.method).toBe('code')
    expect(await session.complete()).toMatchInlineSnapshot(
      `[PoeAuthError: Poe auth failed: no authorization code provided]`,
    )
  })
})

describe('coding plan login', () => {
  test.each([
    ['minimax', minimaxAdapter],
    ['kimi', kimiAdapter],
    ['zai', zaiAdapter],
    ['alibaba', alibabaAdapter],
  ] as const)('%s stores its subscription key', async (_provider, adapter) => {
    const session = await adapter.beginLogin()
    if (session instanceof Error) throw session

    expect(session.method).toBe('code')
    const [first, second] = await Promise.all([
      session.complete('  subscription-key  '),
      session.complete('ignored-key'),
    ])
    expect(first).toBe(second)
    expect(first).toMatchObject({ type: 'api', key: 'subscription-key' })
  })
})

describe('anthropic login', () => {
  test('manualInput switches the flow to a pasted redirect URL', async () => {
    const auto = await anthropicAdapter.beginLogin()
    if (auto instanceof Error) throw auto
    expect(auto.method).toBe('auto')
    expect(new URL(auto.url).searchParams.get('code_challenge_method')).toBe('S256')
    auto.cancel?.()

    const manual = await anthropicAdapter.beginLogin({ manualInput: true })
    if (manual instanceof Error) throw manual
    expect(manual.method).toBe('code')
    expect(manual.instructions).toContain('paste')
    manual.cancel?.()
  })
})
