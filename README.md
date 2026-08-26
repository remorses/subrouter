<div align='center' class='hidden'>
    <br/>
    <br/>
    <h3>subrouter</h3>
    <p>Like OpenRouter, but for your personal AI subscriptions.</p>
    <br/>
    <br/>
</div>

Most people now pay for several AI subscriptions: Claude Pro/Max, ChatGPT Plus/Pro, SuperGrok, opencode Go. Every time one runs out of credits you stop working and start fixing subscriptions: switch models, re-login your harness, repeat. **Subrouter cycles through your subscriptions automatically** when one hits a rate limit or runs out of credits, across accounts of the same provider and across different providers.

```bash
# add your subscriptions
subrouter login anthropic
subrouter login openai
subrouter login xai

# register the opencode plugin
subrouter install opencode

# in opencode, pick the model: subrouter/default
```

When Claude hits its usage limit mid-session, the next request transparently goes to your ChatGPT subscription. When that one is exhausted too, it goes to Grok. You only see an error when **every** subscription is out.

> [!IMPORTANT]
> Subrouter is for **personal use only**. Routing subscription traffic to serve other people or tenants is against the terms of use of most (if not all) subscription providers.

## How it works

```
opencode (model: subrouter/default)
│
└─> ┌──────────────────────┐  preset default
    │ subrouter provider   │  1. anthropic/claude-opus-4-6
    │ (@subrouter/opencode)│  2. openai/gpt-5.5
    └─────────┬────────────┘  3. xai/grok-4.6
              │               4. opencode/grok-4.6
              │
    for each candidate ──> skip if in cooldown
              │
              ├─> ok ──> stream response
              │
              └─> 429 / 402 / usage limit
                       │
                       ├─> account available ──> rotate, retry
                       │
                       └─> exhausted ──> cooldown ──> next provider
```

- **Accounts** live in `~/.subrouter/accounts.json`. Log in multiple times to the same provider to build a rotation pool.
- **Cooldowns** are global per machine (`~/.subrouter/state.json`): once an account is rate limited, every session and harness skips it until the cooldown expires. 429 respects `retry-after` (minimum 5 minutes), 402 (balance exhausted) cools down for 6 hours.
- **Presets** are ordered lists of `provider/model` entries. Every preset is a model in opencode: `subrouter/<preset-name>`.

## Supported subscriptions

| Provider | Subscription | Login flow |
|----------|--------------|------------|
| `anthropic` | Claude Pro / Max | OAuth (browser, PKCE) |
| `openai` | ChatGPT Plus / Pro (Codex backend) | Device code |
| `xai` | SuperGrok / Grok Build | Device code |
| `opencode` | opencode Go (OpenCode Zen) | API key from console.opencode.ai |

Anthropic OAuth requires the requests to look like Claude Code CLI requests; subrouter handles the required request rewriting (system prompt identity, tool names, beta headers) automatically.

## CLI

```bash
subrouter login [provider]                  # add a subscription to the pool
subrouter logout <provider>                 # remove all accounts for a provider
subrouter account list [--json]             # accounts + cooldown status
subrouter account remove <provider> <n|email>

subrouter preset create <name> --models 'anthropic/claude-opus-4-6,xai/grok-4.6'
subrouter preset list
subrouter preset show <name>                # includes currently usable candidates
subrouter preset remove <name>

subrouter status                            # everything at a glance
subrouter cooldown clear                    # retry every account now
subrouter install opencode                  # register the opencode plugin
```

The `default` preset is built in: the newest model of each provider you are logged in to, ranked anthropic, openai, xai, opencode. Create a preset named `default` to override it.

## OpenCode plugin

`@subrouter/opencode` registers a `subrouter` provider inside opencode via the plugin `config` hook. Each preset becomes a model. Install it with:

```bash
subrouter install opencode
```

or manually in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["@subrouter/opencode"]
}
```

Then pick `subrouter/default` (or any `subrouter/<preset>`) as the model. Presets created after opencode starts appear on the next opencode restart.

## Shell Completions

Enable Tab completion for your shell:

```bash
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

pnpm workspace with two packages:

- `cli/` — the `subrouter` package: account stores, presets, cooldown state, provider adapters and the routing engine (`RouterModel`, an AI SDK `LanguageModelV3`)
- `opencode/` — `@subrouter/opencode`: the opencode plugin plus the provider entry opencode loads

```bash
pnpm install
pnpm build
pnpm test
```

Tests never hit real APIs. Unit tests fake provider endpoints with local HTTP servers; the e2e test boots a real `opencode serve`, points the adapters at fake endpoints via `SUBROUTER_*_BASE_URL` env vars, and asserts a rate-limited provider is cycled to the fallback through the entire opencode pipeline.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `SUBROUTER_HOME` | State directory (default `~/.subrouter`) |
| `SUBROUTER_ANTHROPIC_BASE_URL` | Override the Anthropic API base URL (tests) |
| `SUBROUTER_OPENAI_BASE_URL` | Override the Codex API base URL (tests) |
| `SUBROUTER_XAI_BASE_URL` | Override the xAI API base URL (tests) |
| `SUBROUTER_OPENCODE_BASE_URL` | Override the OpenCode Zen base URL (tests) |
