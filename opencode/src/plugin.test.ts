import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { PluginInput } from '@opencode-ai/plugin'
import { subrouterPlugin } from './index.ts'

let home: string

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'subrouter-plugin-'))
  process.env.SUBROUTER_HOME = home
})

afterEach(async () => {
  delete process.env.SUBROUTER_HOME
  await rm(home, { recursive: true, force: true })
})

test('config hook registers the subrouter provider with preset models', async () => {
  await writeFile(
    path.join(home, 'presets.json'),
    JSON.stringify({ version: 1, presets: { work: ['anthropic/claude-opus-4-6'] } }),
  )

  const hooks = await subrouterPlugin({} as PluginInput)
  const config: Record<string, any> = {}
  await hooks.config?.(config as any)

  const provider = config.provider?.subrouter
  expect(provider).toBeTruthy()
  expect(provider.npm.startsWith('file://')).toBe(true)
  expect(provider.npm.endsWith('provider.ts') || provider.npm.endsWith('provider.js')).toBe(true)
  expect(Object.keys(provider.models).sort()).toEqual(['default', 'work'])
  expect(provider.models.default.cost).toEqual({ input: 0, output: 0, cache_read: 0, cache_write: 0 })
})
