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

Most people now pay for several AI subscriptions: **Claude Pro/Max**, **ChatGPT Plus/Pro**, **SuperGrok**, **GitHub Copilot**, **Poe**, **MiniMax**, **Kimi Code**, **Z.ai**, **Alibaba Coding Plan**, **opencode Go**.

Every time one runs out of credits you stop working and start fixing subscriptions: switch models, re-login your harness, repeat.

**Subrouter cycles through your subscriptions automatically** when one hits a rate limit or runs out of credits. It rotates across accounts of the same provider, and across different providers.

## Quick Start

### 1. Add your subscriptions

Run only the login commands for subscriptions you have. **One subscription is enough to start.**

```bash
npx @subrouter/cli login anthropic
npx @subrouter/cli login openai
npx @subrouter/cli login xai
npx @subrouter/cli login opencode-go
npx @subrouter/cli login github-copilot
npx @subrouter/cli login poe
npx @subrouter/cli login minimax
npx @subrouter/cli login kimi
npx @subrouter/cli login zai
npx @subrouter/cli login alibaba
```

Run the same command again to add another account from the same provider. Subrouter rotates through those accounts before moving to the next provider.

### 2. Check your setup

```bash
npx @subrouter/cli status
```

The built-in **`default` preset** ranks the newest model from each provider and automatically filters out providers without an account. You do not need to create a preset.

### 3. Connect your harness

Choose **opencode Go** or **Pi**.

For opencode Go, add `@subrouter/opencode` to the `plugin` array in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["@subrouter/opencode"]
}
```

Restart opencode Go, then pick the model `subrouter/default`.

For Pi, install the extension and pick the same model:

```bash
pi install npm:@subrouter/pi
pi --model subrouter/default
```

When Claude hits its usage limit mid-session, the next request transparently goes to your ChatGPT subscription. When that one is exhausted too, it goes to Grok.

Quota and authentication failures move through the pool until every subscription is out. Normal request errors return immediately, so Subrouter does not repeat a bad request across every subscription.

The CLI command reference below covers account management, custom presets, cooldowns, and shell completions.

> [!IMPORTANT]
> Subrouter is for **personal use only**. Routing subscription traffic to serve other people or tenants is against the terms of use of most (if not all) subscription providers.

## How it works

A preset is an ordered list of `provider/model` candidates. Subrouter walks that list, skips anything in cooldown, and retries on the next account or the next provider.

```diagram
                opencode Go / Pi
                model: subrouter/default
                       │
                       v
                ┌──────────────────────────┐
                │ subrouter harness plugin │
                │ @subrouter/opencode      │
                │ @subrouter/pi            │
                └──────────┬───────────────┘
                           │
                           v
              for each candidate in order
              (default preset: 1.anthropic
                2.openai 3.xai 4.opencode-go
               5.github-copilot 6.poe 7.minimax
               8.kimi 9.zai 10.alibaba)
                           │
                           ├──> cooldown? ──> skip it
                           │
                           ├──> ok ────────> stream
                           │
                           └──> 429/402/quota
                           │
                           └──> cooldown current account
                           │
                           ├──> next candidate ──> rotate
                           │
                           └──> none left ───────> error
```

### Accounts

Accounts live in `~/.subrouter/config.json`. Log in **multiple times to the same provider** to build a rotation pool.

### Cooldowns

Cooldowns are **global per machine** (`~/.subrouter/config.json`). Once an account is rate limited, every session and every harness skips it until the cooldown expires.

| Response                | Cooldown                                                          |
| ----------------------- | ----------------------------------------------------------------- |
| `429` rate limited      | `retry-after` / `retry-after-ms` when present, otherwise 5 minutes |
| `402` balance exhausted | 6 hours                                                           |

### Presets

Presets are ordered lists of `provider/model` entries. Every preset shows up in opencode Go and Pi as `subrouter/<preset-name>`.

## Difference from OpenRouter and API proxies

[OpenRouter](https://openrouter.ai/docs) and [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) expose general-purpose API endpoints. They accept one client protocol and call a provider using another protocol. This requires request conversion, response conversion, and stream parsing inside the proxy.

**Subrouter is a transparent subscription router, not a protocol conversion proxy.** It chooses the account and model, then lets the harness's existing provider implementation handle the complete request and response protocol.

```diagram
OpenRouter / CLIProxyAPI
OpenAI request ──> request translator ──> Anthropic / Gemini request
OpenAI stream  <── response translator <── Anthropic / Gemini stream

Subrouter
                    subrouter chooses account + model
                                   │
              ┌────────────────────┴────────────────────┐
              v                                         v
OpenCode request ──> official AI SDK provider    Pi request ──> Pi native provider
              │                                         │
              v                                         v
      provider-native API                      provider-native API
```

OpenCode already knows how to call providers through the official AI SDK packages. Pi already knows Anthropic Messages, OpenAI Responses, Codex SSE and WebSocket transport, and other provider protocols through its native `pi-ai` package. Subrouter does not replace either implementation.

|                   | Subrouter                         | OpenRouter / CLIProxyAPI                                 |
| ----------------- | --------------------------------- | -------------------------------------------------------- |
| Main job          | Rotate personal subscriptions     | Provide a general API gateway                            |
| Protocol handling | Reuse the harness provider        | Translate requests and responses                         |
| Streaming         | Forward the harness-native stream | Parse and rebuild client-compatible streams              |
| API server        | None                              | OpenAI, Anthropic, Gemini, or other compatible endpoints |
| Scope             | OpenCode and Pi on one machine    | Many clients, providers, and deployment modes            |

This narrow scope keeps **Subrouter much smaller and simpler**. It does not need a unified message schema or a matrix of protocol translators. That removes common bugs around tool calls, reasoning blocks, media, usage fields, and streaming event order.

## Supported subscriptions

| Provider         | Subscription                       | Login flow                          |
| ---------------- | ---------------------------------- | ----------------------------------- |
| `anthropic`      | Claude Pro / Max                   | OAuth (browser, PKCE)               |
| `openai`         | ChatGPT Plus / Pro (Codex backend) | Browser OAuth (PKCE) or device code |
| `xai`            | SuperGrok / Grok Build             | Device code                         |
| `opencode-go`    | opencode Go                        | API key from opencode.ai/auth       |
| `github-copilot` | GitHub Copilot                     | GitHub device code                  |
| `poe`            | Poe subscription points            | Browser OAuth (PKCE)                |
| `minimax`        | MiniMax Token Plan                 | Subscription key                    |
| `kimi`           | Kimi Code                          | Subscription key                    |
| `zai`            | Z.ai GLM Coding Plan               | Subscription key                    |
| `alibaba`        | Alibaba Coding Plan                | Subscription key                    |

Anthropic OAuth only works if requests look like **Claude Code CLI** requests. The OpenCode adapter and Pi's native provider apply the required identity, tool names, and beta headers.

## CLI command reference

Run commands directly with `npx @subrouter/cli`, or install the shorter `subrouter` command globally:

```bash
npm i -g @subrouter/cli
```

### Accounts

```bash
npx @subrouter/cli login [provider] [--input value] # add a subscription to the pool
npx @subrouter/cli logout [provider] [--force]      # remove all accounts for a provider
npx @subrouter/cli account list [--json]     # accounts + cooldown status
npx @subrouter/cli account status [provider] # exits 1 until login completes
npx @subrouter/cli account remove [provider] [n|email] [--force]
npx @subrouter/cli account order --provider anthropic work@x.com personal@x.com
```

`account list` numbers accounts from 1. Run `login` again with the same provider to add another account to its rotation pool. In a terminal, `login` with no provider shows a list to pick from.

`account order` sets the fallback order inside one provider. Pass **every** account email. The first email is tried first.

State lives in **`~/.subrouter/config.json`**. The file includes a `$schema` URL so editors can autocomplete fields: [schema.json](https://subrouter.org/schema.json).

### Presets

```bash
npx @subrouter/cli preset create <name> --models 'anthropic/claude-opus-4-6,xai/grok-4.6' [--force]
npx @subrouter/cli preset list
npx @subrouter/cli preset show [name]       # includes currently usable candidates
npx @subrouter/cli preset remove [name] [--force]
```

The order passed to `--models` is the fallback order. Every preset appears in both harnesses as `subrouter/<name>`.

### Status and cooldowns

```bash
npx @subrouter/cli status                   # everything at a glance
npx @subrouter/cli cooldown clear [--force] # retry every account now
```

**Browser and device login runs in the background** when an agent or non-interactive shell starts it. Approve the URL, then poll for completion:

```bash
npx @subrouter/cli account status anthropic
```

`account status` exits **1 while a login is still running**, even when older accounts are already stored, so polling it never mistakes yesterday's expired token for today's login.

API-key providers accept `--input` in non-interactive shells. Destructive commands ask for confirmation in a terminal and require `--force` elsewhere.

### Replaying the redirect URL

Browser logins finish on a **localhost callback server** owned by the running login process. Anthropic uses port `53692`, OpenAI uses `1455`, and Poe prints a random port chosen for that login. When the browser cannot reach the server, copy the final redirect URL and replay it on the machine that started the login:

```bash
curl 'http://localhost:53692/callback?code=...&state=...'
# Authentication successful. You can close this window.
```

The server accepts any `GET`, so this is the same request the browser would have made.

> [!IMPORTANT]
> The redirect URL contains a **one-time credential**. Run the curl command on the machine that started the login. Do not paste the URL into a shared chat or issue.

```diagram
subrouter login anthropic
        │
        ├──> daemon listens on 127.0.0.1:53692  <── curl replay works here
        │
        └──> 30 min timeout ──> server closes ──> replay gets connection refused
```

The window is **30 minutes**. After that the callback server closes and curl replay stops working, so run `login` again. In an interactive terminal with the browser on another machine, set `SUBROUTER_MANUAL_OAUTH=1`; Subrouter prints the authorize URL, then asks for the final redirect URL.

The `default` preset is built in. It uses the newest model from each provider in the order shown above, filtered to subscriptions with stored accounts. Create a preset named `default` to override it.

## opencode Go plugin

`@subrouter/opencode` registers a `subrouter` provider inside opencode Go via the plugin `config` hook. Each preset becomes a model. Add it to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["@subrouter/opencode"]
}
```

Then pick `subrouter/default` (or any `subrouter/<preset>`) as the model. Presets created after opencode Go starts appear on the next opencode Go restart.

### Use cases

**Rotate when credits run out.** Log in more than one account. When the first subscription hits a rate limit or spends its quota, Subrouter cools it down and sends the next request to the next account. You keep working.

```bash
npx @subrouter/cli login anthropic
npx @subrouter/cli login anthropic   # second Claude account
npx @subrouter/cli login openai
```

Pick `subrouter/default` as the session model. The next request after a 429 or 402 goes to the next account in the preset.

**One model for every agent.** Point the session and every agent at a **subrouter preset**. You log in once per subscription. You do not re-login inside OpenCode when a provider dies. You do not change 100 agent files to swap `anthropic/...` for `openai/...`.

```json
{
  "model": "subrouter/default",
  "agent": {
    "explore": { "model": "subrouter/default" },
    "plan": { "model": "subrouter/default" }
  }
}
```

When Claude is out, ChatGPT takes over. When that one is out, Grok takes over. The model id in config stays `subrouter/default`.

**Tasks and subagents.** OpenCode primary sessions launch specialized agents through the Task tool. **Explore** is the usual case: a fast, read-only agent that searches the repo.

Those agents often pin a **specific model**. When that model hits a rate limit or runs out of credits, the task fails. The parent session then stops with an error, even when other subscriptions still have quota.

Set the agent model to a **subrouter preset**. Subrouter rotates to the next subscription, so the task continues.

```json
{
  "agent": {
    "explore": {
      "model": "subrouter/default"
    }
  }
}
```

The same field works in markdown agents under `~/.config/opencode/agents/`:

```yaml
---
description: Fast read-only codebase search
mode: subagent
model: subrouter/default
---
```

Any other Task subagent works the same way: set `model` to `subrouter/<preset>` instead of a single provider model.

```diagram
                 parent session
                       │
                       v
                    Task tool
                       │
                       v
      explore agent (model: subrouter/default)
                       │
                       ├──> first subscription 429 ──> cooldown
                       │
                       └──> next subscription ──> task continues
```

## Pi plugin

`@subrouter/pi` registers the same presets as models in Pi. It delegates each request to Pi's native provider stream. Poe and Alibaba use Pi's native OpenAI-compatible provider API. Subrouter selects the subscription, but it does not translate requests or responses between provider formats.

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

| Variable                                  | Purpose                                                  |
| ----------------------------------------- | -------------------------------------------------------- |
| `SUBROUTER_HOME`                          | State directory (default `~/.subrouter`)                 |
| `SUBROUTER_MANUAL_OAUTH`                  | Ask for pasted redirect URL (browser on another machine) |
| `SUBROUTER_ANTHROPIC_BASE_URL`            | Override the Anthropic API base URL (tests)              |
| `SUBROUTER_OPENAI_BASE_URL`               | Override the Codex API base URL (tests)                  |
| `SUBROUTER_OPENAI_ISSUER_URL`             | Override the OpenAI auth host (tests)                    |
| `SUBROUTER_XAI_BASE_URL`                  | Override the xAI API base URL (tests)                    |
| `SUBROUTER_OPENCODE_GO_BASE_URL`          | Override the OpenCode Go base URL (tests)                |
| `SUBROUTER_GITHUB_COPILOT_BASE_URL`       | Override the GitHub Copilot API base URL (tests)         |
| `SUBROUTER_GITHUB_COPILOT_GITHUB_URL`     | Override the GitHub OAuth host (tests)                   |
| `SUBROUTER_GITHUB_COPILOT_GITHUB_API_URL` | Override the GitHub API host (tests)                     |
| `SUBROUTER_POE_BASE_URL`                  | Override the Poe API base URL (tests)                    |
| `SUBROUTER_POE_AUTHORIZE_URL`             | Override the Poe authorization URL (tests)               |
| `SUBROUTER_POE_TOKEN_URL`                 | Override the Poe token URL (tests)                       |
| `SUBROUTER_MINIMAX_BASE_URL`              | Override the MiniMax API base URL (tests)                |
| `SUBROUTER_KIMI_BASE_URL`                 | Override the Kimi Code API base URL (tests)              |
| `SUBROUTER_ZAI_BASE_URL`                  | Override the Z.ai API base URL (tests)                   |
| `SUBROUTER_ALIBABA_BASE_URL`              | Override the Alibaba Coding Plan API base URL (tests)    |

Set `SUBROUTER_MANUAL_OAUTH=1` when the browser that authorizes is not on the
machine running subrouter. The localhost callback can never fire there, so
browser login switches to asking for the redirect URL instead. Harnesses that
drive login remotely (kimaki's Discord `/login`) set this for you.
