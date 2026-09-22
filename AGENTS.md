# subrouter agent instructions

subrouter is like OpenRouter, but for **personal AI subscriptions**. Most users pay for several subscriptions (Claude Pro/Max, ChatGPT Plus/Pro, SuperGrok / Grok Build, Cursor, opencode Go). When one runs out of credits, the user has to stop working, switch models in every harness, and re-login constantly. subrouter fixes both problems:

- it cycles through multiple subscriptions when one runs out of credits
- it cycles between subscriptions of **different providers** for quota and authentication failures, following the user's preferred ranking

**Personal use only.** Using subrouter to serve tenant/third-party traffic is against the terms of use of most (if not all) subscription providers. Never add features that encourage multi-tenant serving.

## Core design principle: transparent API passthrough

subrouter must **never translate between AI wire formats**. This is the main robustness property of the project; protect it in every change.

- The router (`RouterModel`) delegates `doGenerate`/`doStream` directly to official `@ai-sdk/*` provider packages (`@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/xai`, `@ai-sdk/openai-compatible`). The result streams/objects are returned to the harness **untouched**.
- Format understanding is the harness's job, wired through `@subrouter/opencode` and `@subrouter/pi`. OpenCode uses the AI SDK. Pi uses its native provider streams. Subrouter only picks *which* subscription serves the request.
- Adapters only touch requests where the subscription gateway **requires** it, and any rewrite must be reversed on the way out:
  - anthropic: OAuth traffic must look like Claude Code CLI (identity system block, tool-name renames, beta headers). The response stream maps tool names **back** to the originals, so the harness never sees the spoofing.
  - openai / xai Responses: `RouterModel` copies OpenCode `providerOptions.subrouter` onto the candidate SDK key (`openai` / `xai` / `anthropic`), then sets `store: false` on both `openai` and `xai`, plus `include: reasoning.encrypted_content` on `openai` only. The xAI SDK schema rejects that include value and adds it on the wire itself when store is false. OpenCode v2 uses store:false plus encrypted reasoning as Responses defaults. OpenCode v1 only sets them when providerID is `openai`/`xai`. Subrouter is providerID `subrouter` with a `file://` npm, so without this patch Codex emits `item_reference` ids, follow-up turns drop thinking that has no encrypted blob, and Grok rejects long replies with `Response is too large to store`. Extra namespaced keys are ignored by other SDKs.
  - openai (Codex backend, fetch rewrite): `store: false` on the wire, `max_output_tokens` stripped, `include: reasoning.encrypted_content` added, stored item `id`s stripped from non-reference `input` items (drop reasoning with no encrypted content), URL rewritten to `chatgpt.com/backend-api/codex/responses`.
  - xai / poe / minimax / kimi / zai / alibaba: bearer injection only.
  - opencode-go: bearer injection plus `x-opencode-session` from the harness session id.
  - github-copilot: bearer injection, API-family routing, and removal of the unsupported Anthropic tool-streaming field.
- The Pi plugin does not use these AI SDK request adapters. It supplies the selected account token to Pi's matching native provider, which owns the required request shape and returns native Pi events.
- Never add "smart" body transformations, prompt mutation, output post-processing, or cross-format proxying (no anthropic→openai translation like generic LLM proxies do). If a provider needs a new quirk, implement the **minimal** request patch in that provider's adapter fetch, document why, and keep everything else byte-transparent.

### Why protocol ownership stays in the harness

Subrouter is a **transparent subscription router**, not a general-purpose compatibility API. It chooses an account and model, then delegates the complete request and stream lifecycle to the protocol implementation that the harness already uses:

- OpenCode delegates through the matching official AI SDK provider. Subrouter returns the provider's `LanguageModelV3` result without converting it to another provider format.
- Pi delegates through `@earendil-works/pi-ai`'s matching native provider. Pi builds the provider request, parses SSE or WebSocket responses, and emits native Pi events. Subrouter forwards those events unchanged.

Do not add a unified message, tool, reasoning, usage, or streaming protocol inside Subrouter. General API gateways such as OpenRouter and CLIProxyAPI need bidirectional translators because they let one client protocol call many different provider protocols. That broader goal requires request converters, response converters, and stateful stream parsers for every supported format pair.

Subrouter deliberately avoids that translation matrix. Reusing the harness's provider implementations keeps the package small and removes whole classes of bugs involving tool calls, reasoning blocks, media, usage accounting, event ordering, and new provider fields. A provider-specific gateway requirement is still allowed, but patch only that requirement and never turn the adapter into a general format converter.

## Repo layout

pnpm workspace, flat `./*` packages. **One root README only, no per-package READMEs.**

- `cli/` — npm package `@subrouter/cli`. Everything lives here:
  - `src/store.ts` — accounts and login state in `~/.subrouter/auth.json`; presets, cooldowns, and live routes in `~/.subrouter/config.json` (override: `SUBROUTER_HOME`). JSON, 0600, lock-dir locking.
  - `src/adapters/` — one adapter per provider (login flow, token refresh, fetch wrapper, `createModel`). Shared failure classification in `adapters/index.ts`.
  - `src/router.ts` — `RouterModel` (AI SDK `LanguageModelV3`) + `createSubrouter` provider factory. Resolves a preset to ranked candidates, skips cooldowns, fails over on rotate-worthy errors.
  - `src/cli.ts` — goke CLI (`login`, `import opencode`, `logout`, `account`, `preset`, `status`, `cooldown clear`).
- `opencode/` — npm package `@subrouter/opencode`. Plugin `config` hook injects a `subrouter` provider whose `npm` field is a `file://` URL to the bundled `provider.js`; every preset becomes a model (`subrouter/<preset>`). Visible provider name is `subrouter.org`. Model labels stay as preset names, while context limits and `experimental.chat.system.transform` follow the first live routed candidate. GPT candidates set a unique `gpt-*` `id` so OpenCode prefers `apply_patch` over `edit`/`write`; `createSubrouter` maps that id back to the preset. Only plugin initializers may be exported from `src/index.ts` (opencode calls every export as a plugin).
- `pi/` — npm package `@subrouter/pi`. Registers one native Pi provider and one logical model per preset. It selects accounts, then delegates to Pi's built-in provider streams without translating events.
- `website/` — Holocron docs site deployed to subrouter.org.

## npm package naming: everything lives in the @subrouter scope

**Every published package MUST be scoped under `@subrouter`.** There is no exception.

The unscoped name `subrouter` on npm is **not ours**. It belongs to a third party:

```
$ npm view subrouter maintainers repository.url
maintainers = 'lawrencechen <lawrencechen2002@gmail.com>'
repository.url = 'git+https://github.com/manaflow-ai/subrouter.git'
```

That package is unrelated to this repo. We can never publish to it, and we must never tell users to install it.

### Rules

- **Never write `npm i -g subrouter`** or `npx subrouter` in a README, docs page, error message, or CLI output. It installs a stranger's package.
- **Never name a workspace package `subrouter`** (unscoped) in `package.json`.
- New packages get `@subrouter/<name>`, matching their folder where possible.

### Naming is separate from the binary and the provider id

Scoping the package does not change any user-facing identifier. Keep these as the bare word `subrouter`:

| Thing | Value | Where |
|---|---|---|
| CLI binary | `subrouter` | `bin` field, so `subrouter login` keeps working |
| opencode / Pi provider id | `subrouter` | `cli/src/router.ts` `PROVIDER_ID` |
| opencode / Pi provider display name | `subrouter.org` | `cli/src/router.ts` `PROVIDER_DISPLAY_NAME` |
| state directory | `~/.subrouter` | `SUBROUTER_HOME` |
| env var prefix | `SUBROUTER_*` | adapters |

Only the **npm package name** must be scoped.

### The bin field must use the object form

Scoped packages derive the binary name from the package name with the scope stripped, so the string form (`"bin": "dist/bin.js"`) would install a binary called `bin`:

```json
"bin": {
  "subrouter": "dist/bin.js"
}
```

### The executable entry is `bin.ts`, not `cli.ts`

`src/cli.ts` only builds the goke command tree and exports `cli`. `src/bin.ts` is the only file that calls `cli.parse(process.argv)`.

Running `node cli/dist/cli.js <command>` therefore **prints nothing and exits 0**. It is not a broken build; no command ever runs. Always run the CLI through the real entry:

```bash
node cli/dist/bin.js login anthropic   # built
bun cli/src/bin.ts login anthropic     # from source
```

### Renaming touches three importers at once

`@subrouter/opencode` resolves the engine by package name:

```
opencode/package.json      "@subrouter/cli": "workspace:^"
opencode/src/provider.ts   export { createSubrouter } from '@subrouter/cli'
opencode/src/index.ts      import { DEFAULT_PRESET_NAME, loadPresets } from '@subrouter/cli'
```

The harness packages depend on `@subrouter/cli` with `workspace:^`.

## Config is implicit and machine-only

Users never hand-edit config files. All state is created through the CLI (`subrouter login`, `subrouter preset create`). Do not add a user-facing editable config file. The `default` preset is built in: a hardcoded ranking of the newest model per provider, filtered to providers with accounts. A user preset named `default` overrides the builtin. Presets appear in both harnesses as `subrouter/<name>`. Ranked entries may append `#variant` (`openai/gpt-5.5#high`). `preset create` validates that variant against models.dev `reasoning_options`. A harness session variant still wins over the preset pin.

## Cooldowns are global machine scope

Rate-limit state lives in `~/.subrouter/config.json`, shared by every process and harness on the machine, so a rate-limited subscription is not retried per-session. Never shorten an existing cooldown. 429 and usage-limit errors honor `retry-after` / `retry-after-ms` when the provider sends them, including `0`. Otherwise 5 minutes. Overloaded / at-capacity errors cool down 1 minute. 402 (balance exhausted) cools down 10 minutes.

Pi's native OpenAI-compatible adapter does not call `onResponse` on HTTP errors. A 429 therefore reaches Subrouter as error text only, without retry headers. OpenCode goes through AI SDK `APICallError.responseHeaders`, which does carry them.

OpenCode does not throw a custom cooldown class into the provider. Rate limits arrive as AI SDK `APICallError` with those headers. Read OpenCode's parser before changing this: https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/retry.ts

## Harness plugins

- **opencode** (`@subrouter/opencode`): done. Users register it in the `plugin` array in `~/.config/opencode/opencode.json`. It exports two plugins: `subrouterPlugin` (config hook, registers the provider) and `subrouterAuthPlugin` (auth hook, drives login).
- **pi** (`@subrouter/pi`): registers logical preset models through the current `@earendil-works/pi-*` APIs. It forwards native Pi stream events unchanged. It retries another candidate only before output starts and never reads Pi's auth store.
- **kimaki**: registers `@subrouter/opencode` next to its own legacy rotation plugins and lists `subrouter` first in Discord `/login`. Its legacy anthropic/openai/xai plugins are marked LEGACY but not deleted, because opencode ships no Claude Pro/Max auth of its own and plain `anthropic/*` model ids would break.

## Login is split into begin/complete

Adapters expose `beginLogin()` returning a `LoginSession`, not a blocking `login()`. Harnesses that cannot sit on a TTY (opencode's auth hook, and through it a Discord bot) need to show `url` + `instructions` immediately and finish later. `runLogin()` in `adapters/index.ts` is the blocking wrapper the CLI uses; never reintroduce a blocking `login` on the adapter interface.

The CLI registers `login [provider]` plus one `login <provider>` command per provider so background attempts keep separate daemon PIDs. Login state lives in `auth.json` under `logins.<provider>`, so different providers can log in concurrently. Every successful harness path calls `addAccount()`, which clears that provider's login state. Keep this invalidation centralized in the store; otherwise an old CLI error can mask a later harness login.

Two contracts to protect:

- **`instructions` is parsed, not just displayed.** Device flows must embed the code as `code: XXXX-XXXX` (uppercase alphanumeric plus dashes). Harnesses regex it out to render the code on its own line. `cli/src/adapters/login.test.ts` asserts this with the same regex kimaki uses.
- **`complete()` is memoized.** Harnesses retry the callback. A second call must return the in-flight promise, not start a second device poll or a second token exchange.
- **Callback redirects are credentials.** Anthropic places the PKCE verifier in `state`. A redirect can be replayed against the live localhost callback server, but instructions must tell users to run curl on the login machine and never paste the URL into a shared chat.

`cancel()` releases anything the session holds, which for anthropic is a listening callback server on port 53692. Call it on any abandoned flow.

## OpenCode source

When you need to see how OpenCode plugins, logging, retries, or provider loading work, read the OpenCode repo. Do not guess from memory.

- GitHub: https://github.com/anomalyco/opencode
- Local cache: `bunx opensrc path anomalyco/opencode`
- Plugin logging: https://opencode.ai/docs/plugins/#logging (`client.app.log`, never `console.log`)
- Runtime logs use a callback passed through provider options into `createSubrouter()` and `RouterModel`. Never use `globalThis`, `Symbol.for`, module-level sinks, stdout, or stderr for library logs.
- Retry headers: https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/retry.ts
- Provider factory load: `packages/opencode/src/provider/provider.ts` calls the first export starting with `create`

## AI SDK version pinning

`@ai-sdk/*` and `@ai-sdk/provider` versions are pinned to match what opencode bundles (provider spec `LanguageModelV3`). When bumping, check opencode's `packages/opencode/package.json` first; a spec mismatch breaks model loading inside opencode.

## Docs site

`website/` is a Holocron site. `website/src/index.mdx` imports the repo `README.md`, so **the README is the docs home page**. Editing the README changes subrouter.org.

Consequences to respect when editing `README.md`:

- **No MDX JSX components** in the README. GitHub renders them as raw text.
- ASCII diagrams must use the ` ```diagram ` fence so Holocron styles them.
- After editing any diagram or table, run the fixer. LLMs cannot count padding.

```bash
npx -y "@holocron.so/cli" diagrams fix README.md
```

Build before deploying; the build reports broken links and MDX errors.

```bash
cd website
pnpm build
pnpm deploy:prod
```

The site is served from two Cloudflare custom domains, `subrouter.org` and `www.subrouter.org`, configured in `website/wrangler.jsonc`.

**Deploy after changing the README.** The site does not rebuild on its own, so an uncorrected README stays live until someone runs `pnpm deploy:prod`.

**Deploy after every npm publish too.** A package release is not complete until the current docs are live on subrouter.org.

## Testing rules

- **No real API calls in tests.** Fake provider endpoints with local HTTP servers; every adapter has a matching `SUBROUTER_<PROVIDER>_BASE_URL` override. `SUBROUTER_MODELS_DEV_URL` points `loadModelsDevCatalog()` at a local catalog.
- `cli/src/router.test.ts` covers rotation order, cooldown recording, non-rotate errors passing through, exhaustion errors.
- `opencode/src/opencode-e2e.test.ts` boots a real `opencode serve` (devDep `opencode-ai`) with fake endpoints and asserts a 429 provider is cycled to the fallback through the whole pipeline. It loads `opencode/dist/provider.js`, so run `pnpm build` before tests.
- `pi/src/pi-e2e.test.ts` loads `pi/dist/index.js` through Pi's real `ResourceLoader`, uses in-memory Pi stores and local HTTP endpoints, and covers account rotation, cross-provider fallback, non-rotate errors, and partial-stream safety.
- Tests use temp `SUBROUTER_HOME` dirs; never touch the real `~/.subrouter`. `store.ts` throws if Vitest would resolve to the real home. Do not `delete process.env.SUBROUTER_HOME` in `afterEach`; a late write then hits `~/.subrouter`.

```bash
pnpm install
pnpm build      # required before opencode e2e
pnpm test
```

## Live opencode CLI checks

Automated tests use fake HTTP servers. After changing adapters, the router, or the OpenCode plugin, also run a **real** `opencode run` against the local plugin. OpenCode loads `@subrouter/cli` from **dist**, so rebuild first:

```bash
pnpm --filter @subrouter/cli build
```

The machine plugin path is already `subrouter/opencode/src/index.ts` in `~/.config/opencode/opencode.json`. Do not use `npx @subrouter/opencode`.

### Isolate vs cycle

Protocol bugs hide if the preset failovers to Anthropic. Use **two** runs:

1. **Isolate Codex.** `-m subrouter/openai-only` has no fallback. A follow-up crash is a real Codex bug.
2. **Prove cycling.** `-m subrouter/openai-first` ranks OpenAI then Anthropic. A usage-limit on Codex must continue on Anthropic.

Check who is live before the cycle run:

```bash
subrouter account list --json
subrouter preset show openai-first
```

Only **rate-limit / usage-limit / 401 / 403 / 402** rotate. A 400 like `Items are not persisted when store is set to false` must **not** cycle. That is a protocol bug; isolating with `openai-only` is how you see it.

### Follow-up turn (the Codex `store:false` case)

One user message that forces a tool, then a second model call:

```bash
opencode run --print-logs --log-level INFO --auto \
  -m subrouter/openai-only \
  --dir /tmp \
  --title 'subrouter-codex-followup' \
  'Use the bash tool to run pwd. Then reply with only the last path segment of that directory.'
```

Pass criteria:

- logs show `providerID=subrouter modelID=openai-only`
- `pwd` runs
- a second `stream` line happens
- **no** `Items are not persisted when store is set to false`
- the process prints the last path segment and `exiting loop`

`--auto` only auto-approves permissions that would **ask**. Explicit **deny** still blocks. This machine already allows `bash`; `--auto` still matters for `external_directory` and `doom_loop`. Docs: https://opencode.ai/docs/permissions/#auto-mode

### Cycling

```bash
opencode run --print-logs --log-level INFO --auto \
  -m subrouter/openai-first \
  --dir /tmp \
  --title 'subrouter-cycle' \
  'Reply with one word: ping'
```

If Codex is in cooldown or returns a usage-limit, logs must show a later stream that succeeds (Anthropic). If Codex is healthy, this run staying on OpenAI is expected. To force a cycle, put a known-limited Codex account first, or wait until it 429s. Do not invent a second account.

### Agents

`--agent oracle` does **not** run oracle. Oracle (and explore) are **subagents**. `opencode run --agent` only accepts a **primary** agent, so it falls back to **build**.

To exercise oracle:

```bash
opencode run --print-logs --log-level INFO --auto \
  -m subrouter/review \
  --dir /tmp \
  --title 'spawn-oracle' \
  'Use the Task tool with subagent_type oracle. Prompt: Reply with one word: pong. Wait. Paste the answer.'
```

Logs must show `agent=oracle mode=subagent` and `modelID=review`, then a follow-up `stream` without the store-false error.

### What not to use

- **TUI.** Agents use `opencode run`.
- `kimaki session export-events-jsonl`. That dump is only for **Discord-mapped** Kimaki sessions. `opencode run` sessions are not in that SQLite buffer. Use `--print-logs` and `kimaki session read <ses_...>`.
- Published npm packages. Always the local workspace plugin + freshly built `cli/dist`.

## Live Pi CLI checks

Rebuild first. Use the **workspace** Pi binary, not a global `pi`. Global installs can be older than the plugin peer (`0.84.3`).

```bash
pnpm --filter @subrouter/cli build
pnpm --filter @subrouter/pi build
```

Load `pi/dist/index.js` with `-e`. Isolate vs cycle uses the same presets as OpenCode (`openai-only`, `openai-first`).

Anthropic Claude Pro/Max OAuth **400s** Pi's default system prompt (`operating inside pi`, `Pi documentation`). The plugin strips that identity before the native Anthropic stream. A live Anthropic fallback that still returns extra-usage is a **prompt leak**, not a quota rotate.

`pi -p` used to hang after a Codex turn because `@subrouter/pi` opens sockets in a second `pi-ai` copy. The plugin now closes them on `session_shutdown`. For SDK scripts still call `session.dispose()`. Set Pi `transport` to `sse` only if you need to isolate a remaining hang.

## Conventions

- errore error handling everywhere (`errore.createTaggedError`, errors as values, `instanceof Error` early returns).
- goke for the CLI (vendored `colors`, `isAgent` guards, clack prompts only in TTY, `.completions()` registered).
- TypeScript per the npm-package template: `rootDir: src`, `.ts` import extensions with `rewriteRelativeImportExtensions`, `type: module`, exports map with `./src` source exports.
- Run `lintcn lint` inside each edited package before finishing a session.

## Real-world validation notes (2026-02)

Verified with a real Claude Pro/Max + ChatGPT login (browser flows driven end to end):

- anthropic PKCE login can hit an **hCaptcha** on the authorize click; the flow still completes after solving it. Identity endpoint returns the email.
- openai Codex device-code flow works as ported from opencode.
- A real cross-provider failover was observed: Codex returned "The usage limit has been reached" → account cooled down → the same request completed on anthropic. The classifier matches that message via the "usage limit" text check.

## Default user-agent inside OpenCode (2026-09)

Inside OpenCode, Bun's default `User-Agent` is `opencode/<version>`, not `Bun/…`. The Claude OAuth token endpoint (`platform.claude.com/v1/oauth/token`) answers that UA with a **fake 429** `rate_limit_error` for every login and refresh. The same request from standalone Bun or Node gets a normal response. Kimaki reported the failure as `Authorization code was invalid or expired`.

- Always set an explicit `user-agent` on requests that providers might fingerprint. Never rely on the runtime default.
- A 429 you cannot reproduce outside OpenCode is probably this. To check, fetch from a project plugin (`.opencode/plugins/*.ts`) through `opencode run` and log `req.rawHeaders` on a local echo server.
- Kimaki's legacy anthropic plugin avoids the issue by sending token requests from a `node` child process, whose UA is `node`. The real cause is the UA, not process state.
