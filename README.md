<div align='center' class='hidden'>
    <br/>
    <br/>
    <h3>subrouter</h3>
    <h4>Like OpenRouter, but for your personal AI subscriptions</h4>
    <p>When one subscription hits its limit, the next one takes over.</p>
    <br/>
    <br/>
</div>

**Like OpenRouter, but for your personal AI subscriptions.**

Most people now pay for several AI subscriptions: **Claude Pro/Max**, **ChatGPT Plus/Pro**, **SuperGrok**, **opencode Go**.

Every time one runs out of credits you stop working and start fixing subscriptions: switch models, re-login your harness, repeat.

**Subrouter cycles through your subscriptions automatically** when one hits a rate limit or runs out of credits. It rotates across accounts of the same provider, and across different providers.

## Quick Start

```bash
# add your subscriptions
npx @subrouter/cli login anthropic
npx @subrouter/cli login openai
npx @subrouter/cli login xai
```

Add `@subrouter/opencode` to the `plugin` array in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["@subrouter/opencode"]
}
```

Restart opencode Go, then pick the model `subrouter/default`.

Or install the Pi extension and pick the same model:

```bash
pi install npm:@subrouter/pi
pi --model subrouter/default
```

When Claude hits its usage limit mid-session, the next request transparently goes to your ChatGPT subscription. When that one is exhausted too, it goes to Grok.

You only see an error when **every** subscription is out.

> [!IMPORTANT]
> Subrouter is for **personal use only**. Routing subscription traffic to serve other people or tenants is against the terms of use of most (if not all) subscription providers.

## How it works

A preset is an ordered list of `provider/model` candidates. Subrouter walks that list, skips anything in cooldown, and retries on the next account or the next provider.

```diagram
   opencode Go / Pi
   model: subrouter/default
        │
        v
   ┌───────────────────────────────┐  preset "default"
   │ subrouter harness plugin      │ → 1. anthropic/claude-opus-4-6
   │ @subrouter/opencode           │  2. openai/gpt-5.5
   │ @subrouter/pi                 │  3. xai/grok-4.6
   └──────────────┬────────────────┘  4. opencode/grok-4.6
                  │
                  v
   for each candidate in order
                  │
                  ├─> in cooldown? ──> skip it, take next candidate
                  │
                  ├─> ok ──> stream the response
                  │
                  └─> 429 / 402 / usage limit
                                │
                                ├─> another account left? ──> rotate, retry
                                │
                                └─> none left ──> cooldown, next candidate
```

### Accounts

Accounts live in `~/.subrouter/accounts.json`. Log in **multiple times to the same provider** to build a rotation pool.

### Cooldowns

Cooldowns are **global per machine** (`~/.subrouter/state.json`). Once an account is rate limited, every session and every harness skips it until the cooldown expires.

| Response                | Cooldown                                |
| ----------------------- | --------------------------------------- |
| `429` rate limited      | `retry-after` header, minimum 5 minutes |
| `402` balance exhausted | 6 hours                                 |

### Presets

Presets are ordered lists of `provider/model` entries. Every preset shows up in opencode Go and Pi as `subrouter/<preset-name>`.

## Supported subscriptions

| Provider    | Subscription                       | Login flow                          |
| ----------- | ---------------------------------- | ----------------------------------- |
| `anthropic` | Claude Pro / Max                   | OAuth (browser, PKCE)               |
| `openai`    | ChatGPT Plus / Pro (Codex backend) | Browser OAuth (PKCE) or device code |
| `xai`       | SuperGrok / Grok Build             | Device code                         |
| `opencode`  | opencode Go                        | API key from console.opencode.ai    |

Anthropic OAuth only works if requests look like **Claude Code CLI** requests. The OpenCode adapter and Pi's native provider apply the required identity, tool names, and beta headers.

## CLI

```bash
npx @subrouter/cli login [provider]         # add a subscription to the pool
npx @subrouter/cli logout <provider>        # remove all accounts for a provider
npx @subrouter/cli account list [--json]    # accounts + cooldown status
npx @subrouter/cli account remove <provider> <n|email>

npx @subrouter/cli preset create <name> --models 'anthropic/claude-opus-4-6,xai/grok-4.6'
npx @subrouter/cli preset list
npx @subrouter/cli preset show <name>       # includes currently usable candidates
npx @subrouter/cli preset remove <name>

npx @subrouter/cli status                   # everything at a glance
npx @subrouter/cli cooldown clear           # retry every account now
```

Prefer a short command? Install it globally and every example becomes `subrouter <command>`:

```bash
npm i -g @subrouter/cli
```

The `default` preset is built in: the newest model of each provider you are logged in to, ranked anthropic, openai, xai, opencode. Create a preset named `default` to override it.

## opencode Go plugin

`@subrouter/opencode` registers a `subrouter` provider inside opencode Go via the plugin `config` hook. Each preset becomes a model. Add it to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["@subrouter/opencode"]
}
```

Then pick `subrouter/default` (or any `subrouter/<preset>`) as the model. Presets created after opencode Go starts appear on the next opencode Go restart.

## Pi plugin

`@subrouter/pi` registers the same presets as models in Pi. It delegates each request to Pi's native Anthropic, Codex, xAI, or opencode provider stream. Subrouter selects the subscription, but it does not translate requests or responses between provider formats.

```bash
pi install npm:@subrouter/pi
pi --model subrouter/default
```

Presets created after Pi starts appear after `/reload` or the next restart.

## Shell Completions

Completions hook into the `subrouter` command, so this one needs a **global install** rather than `npx`:

```bash
npm i -g @subrouter/cli
subrouter completions install
```

Restart your shell (or run `autoload -Uz compinit && compinit` for zsh). Then Tab works:

```bash
subrouter <TAB>          # shows all commands
subrouter pre<TAB>       # completes to "preset"
subrouter login --<TAB>  # shows available options
```

Completions stay up-to-date automatically. To remove:

```bash
subrouter completions uninstall
```

## Development

pnpm workspace with three packages:

- `cli/` — `@subrouter/cli`: account stores, presets, cooldown state, provider adapters and the routing engine (`RouterModel`, an AI SDK `LanguageModelV3`)
- `opencode/` — `@subrouter/opencode`: the opencode Go plugin plus the provider entry opencode Go loads
- `pi/` — `@subrouter/pi`: a native Pi provider that delegates to Pi's provider streams without format translation

```bash
pnpm install
pnpm build
pnpm test
```

**Tests never hit real APIs.** Unit tests fake provider endpoints with local HTTP servers.

The e2e tests boot real opencode Go and Pi harness runtimes, point every adapter at local endpoints via `SUBROUTER_*_BASE_URL`, and assert that a rate-limited provider cycles to the fallback through each complete pipeline. Pi uses in-memory auth, model, settings, and session stores, so tests never read or write the real Pi config.

## Environment variables

| Variable                       | Purpose                                                      |
| ------------------------------ | ------------------------------------------------------------ |
| `SUBROUTER_HOME`               | State directory (default `~/.subrouter`)                     |
| `SUBROUTER_MANUAL_OAUTH`       | Browser is on another machine: ask for a pasted redirect URL |
| `SUBROUTER_ANTHROPIC_BASE_URL` | Override the Anthropic API base URL (tests)                  |
| `SUBROUTER_OPENAI_BASE_URL`    | Override the Codex API base URL (tests)                      |
| `SUBROUTER_OPENAI_ISSUER_URL`  | Override the OpenAI auth host (tests)                        |
| `SUBROUTER_XAI_BASE_URL`       | Override the xAI API base URL (tests)                        |
| `SUBROUTER_OPENCODE_BASE_URL`  | Override the opencode Go base URL (tests)                    |

Set `SUBROUTER_MANUAL_OAUTH=1` when the browser that authorizes is not on the
machine running subrouter. The localhost callback can never fire there, so the
anthropic flow switches to asking for the redirect URL instead. Harnesses that
drive login remotely (kimaki's Discord `/login`) set this for you.
