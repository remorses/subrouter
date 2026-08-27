/** Poe subscription adapter using OAuth-issued API keys and OpenAI-compatible requests. */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import * as errore from 'errore'
import { createServer, type Server } from 'node:http'
import type { StoredAccount } from '../store.ts'
import {
  callbackLoginInstructions,
  resolveBaseUrl,
  type BeginLoginArgs,
  type LoginSession,
  type ProviderAdapter,
} from './index.ts'

export class PoeAuthError extends errore.createTaggedError({
  name: 'PoeAuthError',
  message: 'Poe auth failed: $reason',
}) {}

const CLIENT_ID = 'client_728290227fc048cc9262091a1ea197ea'
const CALLBACK_PATH = '/callback'
const MANUAL_REDIRECT_URI = `http://127.0.0.1:53693${CALLBACK_PATH}`
const OAUTH_TIMEOUT_MS = 30 * 60 * 1000

function poeApiUrl() {
  return resolveBaseUrl({ envVar: 'SUBROUTER_POE_BASE_URL', fallback: 'https://api.poe.com/v1' })
}

function poeTokenUrl() {
  return process.env.SUBROUTER_POE_TOKEN_URL || 'https://api.poe.com/token'
}

async function generatePKCE() {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: Buffer.from(hash).toString('base64url') }
}

export function buildPoeAuthorizeUrl({
  redirectUri,
  challenge,
  state,
}: {
  redirectUri: string
  challenge: string
  state: string
}) {
  const endpoint = process.env.SUBROUTER_POE_AUTHORIZE_URL || 'https://poe.com/oauth/authorize'
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: 'apikey:create',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    redirect_uri: redirectUri,
    state,
  })
  return `${endpoint}?${params.toString()}`
}

export function parsePoeCallbackInput({ input, state }: { input: string | undefined; state: string }) {
  const value = input?.trim()
  if (!value) return new PoeAuthError({ reason: 'no authorization code provided' })
  const url = errore.try(() => new URL(value))
  if (url instanceof Error) return value
  const error = url.searchParams.get('error_description') || url.searchParams.get('error')
  if (error) return new PoeAuthError({ reason: error })
  if (url.searchParams.get('state') !== state) return new PoeAuthError({ reason: 'invalid OAuth state' })
  return url.searchParams.get('code') || new PoeAuthError({ reason: 'missing authorization code' })
}

async function startCallbackServer({ state }: { state: string }) {
  let settle: ((result: Error | string) => void) | undefined
  const result = new Promise<Error | string>((resolve) => {
    settle = resolve
  })
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    if (url.pathname !== CALLBACK_PATH) {
      response.writeHead(404).end('Not found')
      return
    }
    const code = parsePoeCallbackInput({ input: url.href, state })
    settle?.(code)
    response.writeHead(code instanceof Error ? 400 : 200).end(
      code instanceof Error ? code.message : 'Authorization successful. You can close this window.',
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    return new PoeAuthError({ reason: 'failed to bind callback server' })
  }
  return {
    redirectUri: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
    waitForCode: () => result,
    close() {
      settle?.(new PoeAuthError({ reason: 'login cancelled' }))
      server.close()
    },
  }
}

async function exchangeCode({ code, verifier, redirectUri }: { code: string; verifier: string; redirectUri: string }) {
  const response = await fetch(poeTokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
    }).toString(),
  }).catch((cause) => new PoeAuthError({ reason: 'token exchange failed', cause }))
  if (response instanceof Error) return response
  if (!response.ok) return new PoeAuthError({ reason: `token exchange returned ${response.status}` })

  const token = (await response.json().catch(() => null)) as {
    api_key?: string
    api_key_expires_in?: number | null
  } | null
  if (!token?.api_key) return new PoeAuthError({ reason: 'token response missing API key' })
  const now = Date.now()
  return {
    type: 'oauth',
    refresh: token.api_key,
    access: token.api_key,
    expires: token.api_key_expires_in == null ? undefined : now + token.api_key_expires_in * 1000,
    addedAt: now,
    lastUsed: now,
  } satisfies StoredAccount
}

async function beginLogin(args?: BeginLoginArgs): Promise<Error | LoginSession> {
  const pkce = await generatePKCE()
  const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
  const callback = args?.manualInput
    ? undefined
    : await startCallbackServer({ state }).catch(
        (cause) => new PoeAuthError({ reason: 'failed to start callback server', cause }),
      )
  if (callback instanceof Error) return callback
  const redirectUri = callback?.redirectUri ?? MANUAL_REDIRECT_URI
  let pending: Promise<Error | StoredAccount> | undefined

  return {
    url: buildPoeAuthorizeUrl({ redirectUri, challenge: pkce.challenge, state }),
    instructions: args?.manualInput
      ? 'Authorize Poe in your browser, then paste the final localhost redirect URL.'
      : callbackLoginInstructions({ subscription: 'Poe', redirectUri }),
    method: args?.manualInput ? 'code' : 'auto',
    complete(input) {
      pending ??= (async () => {
        const code = await (async () => {
          if (input?.trim()) return parsePoeCallbackInput({ input, state })
          if (!callback) return new PoeAuthError({ reason: 'no authorization code provided' })
          return Promise.race([
            callback.waitForCode(),
            new Promise<PoeAuthError>((resolve) => {
              const timeout = setTimeout(
                () => resolve(new PoeAuthError({ reason: 'OAuth callback timed out' })),
                OAUTH_TIMEOUT_MS,
              )
              timeout.unref()
            }),
          ])
        })()
        callback?.close()
        if (code instanceof Error) return code
        return exchangeCode({ code, verifier: pkce.verifier, redirectUri })
      })()
      return pending
    },
    cancel() {
      callback?.close()
    },
  }
}

async function getPoeApiKey({ account }: { account: StoredAccount }) {
  const key = account.key || account.access || account.refresh
  if (!key) return new PoeAuthError({ reason: 'account has no API key' })
  if (account.expires && account.expires <= Date.now()) {
    return new PoeAuthError({ reason: 'API key expired, re-login required' })
  }
  return key
}

function buildFetch(account: StoredAccount) {
  return async (input: Request | string | URL, init?: RequestInit) => {
    const key = await getPoeApiKey({ account })
    if (key instanceof Error) throw key
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    if (init?.headers) new Headers(init.headers).forEach((value, name) => headers.set(name, value))
    headers.set('authorization', `Bearer ${key}`)
    return fetch(input, { ...init, headers })
  }
}

export const poeAdapter: ProviderAdapter = {
  id: 'poe',
  name: 'Poe',
  defaultModels: ['anthropic/claude-opus-4.8', 'openai/gpt-5.5'],
  baseUrlEnvVar: 'SUBROUTER_POE_BASE_URL',
  createModel({ modelId, account }) {
    return createOpenAICompatible({
      name: 'poe',
      apiKey: 'subrouter-oauth',
      baseURL: poeApiUrl(),
      fetch: buildFetch(account) as typeof fetch,
      includeUsage: true,
    }).languageModel(modelId)
  },
  getApiKey: getPoeApiKey,
  beginLogin,
}
