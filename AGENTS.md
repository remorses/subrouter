# subrouter agent instructions

subrouter is like OpenRouter, but for **personal AI subscriptions**. Most users pay for several subscriptions (Claude Pro/Max, ChatGPT Plus/Pro, SuperGrok / Grok Build, Cursor, opencode Go). When one runs out of credits, the user has to stop working, switch models in every harness, and re-login constantly. subrouter fixes both problems:

- it cycles through multiple subscriptions when one runs out of credits
- it cycles between subscriptions of **different providers**, following the user's preferred ranking, and only errors when every subscription is exhausted

**Personal use only.** Using subrouter to serve tenant/third-party traffic is against the terms of use of most (if not all) subscription providers. Never add features that encourage multi-tenant serving.

## Core design principle: transparent API passthrough

subrouter must **never translate between AI wire formats**. This is the main robustness property of the project; protect it in every change.

- The router (`RouterModel`) delegates `doGenerate`/`doStream` directly to official `@ai-sdk/*` provider packages (`@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/xai`, `@ai-sdk/openai-compatible`). The result streams/objects are returned to the harness **untouched**.
- Format understanding is the harness's job, wired through harness-specific plugins (`@subrouter/opencode` today, a pi plugin later). The harness already speaks Anthropic and OpenAI formats through the AI SDK; subrouter only picks *which* subscription serves the request.
- Adapters only touch requests where the subscription gateway **requires** it, and any rewrite must be reversed on the way out:
  - anthropic: OAuth traffic must look like Claude Code CLI (identity system block, tool-name renames, beta headers). The response stream maps tool names **back** to the originals, so the harness never sees the spoofing.
  - openai (Codex backend): `store: false` forced, `max_output_tokens` stripped, URL rewritten to `chatgpt.com/backend-api/codex/responses`. These are hard endpoint requirements (verified against the real API), not conveniences. Codex is stream-only.
  - xai / opencode zen: bearer injection only.
- Never add "smart" body transformations, prompt mutation, output post-processing, or cross-format proxying (no anthropic→openai translation like generic LLM proxies do). If a provider needs a new quirk, implement the **minimal** request patch in that provider's adapter fetch, document why, and keep everything else byte-transparent.

## Repo layout

pnpm workspace, flat `./*` packages. **One root README only, no per-package READMEs.**

- `cli/` — npm package `@subrouter/cli`. Everything lives here:
  - `src/store.ts` — accounts, presets, cooldown state under `~/.subrouter` (override: `SUBROUTER_HOME`). JSON files, 0600, lock-dir locking.
  - `src/adapters/` — one adapter per provider (login flow, token refresh, fetch wrapper, `createModel`). Shared failure classification in `adapters/index.ts`.
  - `src/router.ts` — `RouterModel` (AI SDK `LanguageModelV3`) + `createSubrouter` provider factory. Resolves a preset to ranked candidates, skips cooldowns, fails over on rotate-worthy errors.
  - `src/cli.ts` — goke CLI (`login`, `logout`, `account`, `preset`, `status`, `cooldown clear`).
- `opencode/` — npm package `@subrouter/opencode`. Plugin `config` hook injects a `subrouter` provider whose `npm` field is a `file://` URL to the bundled `provider.js`; every preset becomes a model (`subrouter/<preset>`). Only plugin initializers may be exported from `src/index.ts` (opencode calls every export as a plugin).
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
| opencode provider id | `subrouter` | `cli/src/router.ts` |
| state directory | `~/.subrouter` | `SUBROUTER_HOME` |
| env var prefix | `SUBROUTER_*` | adapters |

Only the **npm package name** must be scoped.

### The bin field must use the object form

Scoped packages derive the binary name from the package name with the scope stripped, so the string form (`"bin": "dist/cli.js"`) would install a binary called `cli`:

```json
"bin": {
  "subrouter": "dist/cli.js"
}
```

### Renaming touches three importers at once

`@subrouter/opencode` resolves the engine by package name:

```
opencode/package.json      "@subrouter/cli": "workspace:^"
opencode/src/provider.ts   export { createSubrouter } from '@subrouter/cli'
opencode/src/index.ts      import { DEFAULT_PRESET_NAME, loadPresets } from '@subrouter/cli'
```

Both packages are at version `0.0.0`, so **nothing has been published yet**.

## Config is implicit and machine-only

Users never hand-edit config files. All state is created through the CLI (`subrouter login`, `subrouter preset create`). Do not add a user-facing editable config file. The `default` preset is built in: a hardcoded ranking of the newest model per provider (opus, gpt-5.x, grok 4.6, zen), filtered to providers with accounts. A user preset named `default` overrides the builtin. Presets appear in opencode as `subrouter/<name>`.

## Cooldowns are global machine scope

Rate-limit state lives in `~/.subrouter/state.json`, shared by every process and harness on the machine, so a rate-limited subscription is not retried per-session. Never shorten an existing cooldown. 429 honors `retry-after` (min 5 minutes); 402 (balance exhausted) cools down 6 hours.

## Harness plugins

- **opencode** (`@subrouter/opencode`): done. Users register it in the `plugin` array in `~/.config/opencode/opencode.json`. It exports two plugins: `subrouterPlugin` (config hook, registers the provider) and `subrouterAuthPlugin` (auth hook, drives login).
- **pi** (badlogic pi-mono): planned next harness plugin. Same architecture: a thin plugin registers the subrouter provider inside pi; the router and adapters in `cli/` stay harness-agnostic. Keep everything reusable from `cli/` so the pi package is as thin as the opencode one.
- **kimaki**: registers `@subrouter/opencode` next to its own legacy rotation plugins and lists `subrouter` first in Discord `/login`. Its legacy anthropic/openai/xai plugins are marked LEGACY but not deleted, because opencode ships no Claude Pro/Max auth of its own and plain `anthropic/*` model ids would break.

## Login is split into begin/complete

Adapters expose `beginLogin()` returning a `LoginSession`, not a blocking `login()`. Harnesses that cannot sit on a TTY (opencode's auth hook, and through it a Discord bot) need to show `url` + `instructions` immediately and finish later. `runLogin()` in `adapters/index.ts` is the blocking wrapper the CLI uses; never reintroduce a blocking `login` on the adapter interface.

Two contracts to protect:

- **`instructions` is parsed, not just displayed.** Device flows must embed the code as `code: XXXX-XXXX` (uppercase alphanumeric plus dashes). Harnesses regex it out to render the code on its own line. `cli/src/adapters/login.test.ts` asserts this with the same regex kimaki uses.
- **`complete()` is memoized.** Harnesses retry the callback. A second call must return the in-flight promise, not start a second device poll or a second token exchange.

`cancel()` releases anything the session holds, which for anthropic is a listening callback server on port 53692. Call it on any abandoned flow.

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

## Testing rules

- **No real API calls in tests.** Fake provider endpoints with local HTTP servers; adapters read `SUBROUTER_ANTHROPIC_BASE_URL`, `SUBROUTER_OPENAI_BASE_URL`, `SUBROUTER_XAI_BASE_URL`, `SUBROUTER_OPENCODE_BASE_URL` overrides.
- `cli/src/router.test.ts` covers rotation order, cooldown recording, non-rotate errors passing through, exhaustion errors.
- `opencode/src/opencode-e2e.test.ts` boots a real `opencode serve` (devDep `opencode-ai`) with fake endpoints and asserts a 429 provider is cycled to the fallback through the whole pipeline. It loads `opencode/dist/provider.js`, so run `pnpm build` before tests.
- Tests use temp `SUBROUTER_HOME` dirs; never touch the real `~/.subrouter`.

```bash
pnpm install
pnpm build      # required before opencode e2e
pnpm test
```

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
