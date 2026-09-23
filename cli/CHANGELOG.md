<!-- Release history for the @subrouter/cli package. -->

# Changelog

## 0.6.1

1. **Fixed Claude Pro/Max login and token refresh inside OpenCode.** Bun sends `User-Agent: opencode/<version>` by default, and the Claude OAuth token endpoint answers it with a fake rate limit, so every login and refresh failed:

   ```
   token endpoint returned 429: {"error": {"type": "rate_limit_error", "message": "Rate limited. Please try again later."}}
   ```

   Harnesses like the Kimaki Discord bot showed this as `Authorization code was invalid or expired`. Token requests now send the Claude Code user-agent, the same one Anthropic API calls already use.

2. **Advertise Claude Code `2.1.280` on Anthropic OAuth requests.** Anthropic returns 400 when the Claude Code client is older than `2.1.280`:

   ```
   Claude Code 2.1.257 does not support this model; version 2.1.280 or newer is required.
   ```

   The Anthropic adapter now sends `user-agent: claude-cli/2.1.280 (external, cli)`.

3. **Retry OpenAI WebSocket 1006 drops instead of rotating the account.** A `code 1006` abnormal close (`OpenAI WebSocket failed: closed before response completed`) is a transient network failure, not a quota or auth rejection. Subrouter no longer cools down the account for 5 minutes. It is wrapped as a retryable `APICallError`, so OpenCode retries the turn on the same subscription with its normal backoff. A `code 1008` policy-violation close is still terminal.

## 0.6.0

1. **Import matching OpenCode logins** instead of repeating `subrouter login` for every provider.

   ```bash
   npx @subrouter/cli import opencode
   npx @subrouter/cli import opencode --from ~/.local/share/opencode/auth.json
   ```

   Only providers Subrouter supports are copied into `~/.subrouter/auth.json`. Existing accounts with the same identity are updated. The auth file schema is at https://subrouter.org/auth.schema.json.

2. **Split tokens from runtime config.** Tokens now live in `~/.subrouter/auth.json`. Presets, cooldowns, and live routes stay in `~/.subrouter/config.json`. Older combined `config.json` files split on the next write.

   Editors can autocomplete both files from `$schema`:

   - https://subrouter.org/auth.schema.json
   - https://subrouter.org/config.schema.json

   https://subrouter.org/schema.json still serves the config schema.

3. **Pin reasoning effort on preset entries with `#variant`.** `preset create` accepts ranked entries like `openai/gpt-5.5#high` and `anthropic/claude-opus-4-6#max`. Unknown or unsupported variants fail at create time against models.dev `reasoning_options`.

   ```bash
   npx @subrouter/cli preset create work --models 'anthropic/claude-opus-4-6#max,openai/gpt-5.5#high'
   ```

   A harness session `--variant` still wins over the preset pin. If the live fallback does not list that session variant, Subrouter uses the candidate pin or the provider default instead of sending an unsupported effort.

4. **Keep each user message on the provider, model, and account that accepted it.** Tool-result follow-ups no longer jump back to a higher-ranked subscription when its cooldown expires mid-run. New user messages still start from the preset ranking.

5. **Persist the in-flight route per session.** `resolveLiveModel({ preset, sessionID })` returns the provider/model that accepted the current run. After failover, later calls in the same session keep showing that fallback until the session goes idle.

6. **Replay previous thinking on Codex and Grok follow-up turns.** RouterModel copies `providerOptions.subrouter` onto the live SDK (`openai` / `xai` / `anthropic`), forces Responses `store: false` on OpenAI and xAI, and asks for `reasoning.encrypted_content`. Long Grok replies no longer fail with `Response is too large to store`. Without the encrypted blob, Codex still drops summary-only thinking. That is required: `store: false` cannot point at `rs_*` ids.

7. **Prefer OpenCode `apply_patch` when the live model is GPT.** GPT presets now spoof a unique `gpt-*` API id so OpenCode hides `edit`/`write` and loads the Codex system prompt. The provider maps that id back to the preset.

8. **Send `x-opencode-session` on OpenCode Go inference requests.** RouterModel copies the harness session id onto that header. Calls without a harness session id get a random UUID so the request still succeeds.

9. **Retry provider timeouts in OpenCode** instead of killing the session. Network failures such as `The operation timed out`, connect timeouts, and undici header/body timeouts are thrown as retryable `APICallError`s. Subrouter does not rotate or cool down on a timeout.

10. **Shorten two cooldown defaults.** Balance / quota exhausted (`402`) now cools for **10 minutes** instead of 6 hours. Overloaded / at-capacity messages cool for **1 minute**. `retry-after` / `retry-after-ms` still win when the provider sends them. A normal `429` without those headers still defaults to 5 minutes.

11. **Preserve structured provider stream errors** instead of displaying `[object Object]`. OpenAI Responses API errors keep their nested message so Subrouter can classify rate limits and report the real provider error.

## 0.5.0

1. **Route media inputs only through compatible subscriptions.** Subrouter reads input modalities from models.dev and skips candidates that cannot accept the current prompt while preserving the configured ranking. A PDF request can now fail over from OpenAI without reaching a provider that cannot transport PDFs. Registered model metadata also preserves models.dev input-token limits.

2. **Retry failures that happen before semantic stream output.** OpenAI WebSocket code 1006 disconnects and routed 401, 403, 429, usage-limit, and spending-limit failures now cool down the failed account and reach OpenCode as retryable API errors. OpenCode can restart the turn on the next subscription instead of ending the session.

   Failures after text, reasoning, or tool output still cool down the account but never replay the turn. This prevents duplicate output and repeated tool side effects.

3. **Keep runtime logging local to each router instance.** `createSubrouter()` and `RouterModel` now accept a `log` callback, and cooldown fallback routing can be observed through `onCooldownFallback`. Subrouter no longer writes to stdout or stderr when a harness loads it or routes a request. Separate harnesses and provider instances cannot leak log destinations into each other.

## 0.4.0

1. **Log which subscription is tried** when OpenCode prints logs. Cycle events go through `client.app.log`, never stdout:

   ```
   trying openai/gpt-5.5 #1 (work@x.com)
   failover openai/gpt-5.5 #1 (work@x.com) error="The usage limit has been reached"
   trying openai/gpt-5.5 #2 (personal@x.com)
   ```

   Pi has no log API, so those runs stay silent.

2. **Set the fallback order inside one provider.** Pass every account email. The first email is tried first:

   ```bash
   npx @subrouter/cli account order --provider anthropic work@x.com personal@x.com
   ```

3. **Pick a subscription in the terminal** when you omit the provider. The same interactive prompt works for logout, account remove, preset show, and preset remove:

   ```bash
   npx @subrouter/cli login
   npx @subrouter/cli logout
   ```

   Agents and non-interactive shells still need an explicit provider.

4. **Honor the provider `retry-after` period** instead of waiting at least 5 minutes. A 30 second header cools for 30 seconds. `Retry-After: 0` or a past HTTP date means the account can be tried on the next request. Missing or invalid headers still default to 5 minutes. Exhausted balances still cool for 6 hours.

5. **Start streaming as soon as the provider answers**, instead of waiting for the first visible token. Grok thinking used to look hung because Subrouter held the stream until the first token.

6. **Use `opencode-go` for the OpenCode Go plan.** `opencode` is Zen pay-as-you-go on models.dev. Existing `providers.opencode` accounts, `opencode/...` presets, and matching cooldowns move to `opencode-go` on first load:

   ```bash
   npx @subrouter/cli login opencode-go
   ```

   Copy new keys from https://opencode.ai/auth.

7. **Store accounts, presets, cooldowns, and logins in one `~/.subrouter/config.json`.** Older `accounts.json`, `presets.json`, `state.json`, and `login-*.json` files are merged on first load, then replaced. Editors can autocomplete from the `$schema` URL at https://subrouter.org/schema.json.

8. **Keep ChatGPT follow-up turns working** by forcing Codex `store: false` on the AI SDK and the wire. OpenCode no longer hits `Items are not persisted when store is set to false` after a tool call.

9. **Make browser login survivable from a chat window.** Background login prints the authorize URL again. `account status` stays unsuccessful until the in-flight login finishes. Manual Anthropic login no longer opens a localhost callback port. Replay a missed redirect with curl on the login machine; do not paste that URL into a shared chat.

10. **Reject non-text models in presets** so image-only or audio-only catalog ids fail at `preset create` instead of at request time.

11. **Fall back to HTTP when a Codex WebSocket cannot be used**, instead of failing the ChatGPT request.

## 0.3.0

1. **Complete browser and device login without blocking agents:** login now continues in a background process in agent and non-interactive shells. Approve the displayed URL, then poll until the account is ready:

   ```bash
   npx @subrouter/cli login anthropic
   npx @subrouter/cli account status anthropic
   ```

2. **Pass login values explicitly with `--input`:** non-interactive shells can add API-key subscriptions or submit manual OAuth redirects without a prompt:

   ```bash
   npx @subrouter/cli login opencode --input "$OPENCODE_API_KEY"
   SUBROUTER_MANUAL_OAUTH=1 npx @subrouter/cli login anthropic --input "$REDIRECT_URL"
   ```

3. **Confirm destructive commands before changing local state:** account removal, provider logout, preset replacement, preset removal, and cooldown clearing now ask for confirmation in a terminal. Scripts and agents can confirm explicitly with `--force`:

   ```bash
   npx @subrouter/cli account remove anthropic 2 --force
   npx @subrouter/cli preset remove work --force
   ```

4. **Keep subscription keys out of account labels:** API-key accounts are now shown as `API key` instead of exposing part of the stored secret.

## 0.2.0

1. **Route through six more personal subscription providers:** add GitHub Copilot, Poe, MiniMax Token Plan, Kimi Code, Z.ai GLM Coding Plan, and Alibaba Coding Plan accounts to the same ranked failover pool:

   ```bash
   npx @subrouter/cli login github-copilot
   npx @subrouter/cli login poe
   npx @subrouter/cli login minimax
   npx @subrouter/cli login kimi
   npx @subrouter/cli login zai
   npx @subrouter/cli login alibaba
   ```

2. **Log in to ChatGPT with browser OAuth:** browser PKCE is now the recommended OpenAI flow, while device-code login remains available:

   ```bash
   npx @subrouter/cli login openai --method browser
   npx @subrouter/cli login openai --method device
   ```

   Login sessions can also be completed by non-TTY harnesses. Set `SUBROUTER_MANUAL_OAUTH=1` when the authorizing browser is on another machine and paste the final redirect URL back into the harness.

3. **Reuse ChatGPT Codex WebSockets in OpenCode sessions:** OpenAI Responses requests with session affinity now share an account-scoped WebSocket. Subrouter falls back to HTTP when a socket cannot be used, rotates only before user-visible output starts, and still records cooldowns for usage-limit failures after output starts.

4. **Validate preset model IDs before saving:** `preset create` now checks each `provider/model` entry against the current models.dev catalog, so invalid model names fail before they reach a harness:

   ```bash
   npx @subrouter/cli preset create work \
     --models 'anthropic/claude-opus-4-6,openai/gpt-5.5,github-copilot/claude-opus-5'
   ```

5. **Expose credentials to native harness providers:** adapters now provide `getApiKey()` and split login into memoized `beginLogin()` and `complete()` stages. Pi and other harness integrations can select accounts with Subrouter while keeping their native request and stream implementations.

6. **Register the OpenCode plugin directly:** the removed `subrouter install opencode` command is replaced by the standard OpenCode plugin configuration:

   ```json
   {
     "plugin": ["@subrouter/opencode"]
   }
   ```

## 0.1.0

1. **Route requests across personal AI subscriptions:** use Claude Pro/Max, ChatGPT Plus/Pro, SuperGrok, and opencode Go accounts through one AI SDK provider. When an account reaches a rate or usage limit, subrouter tries the next account and then the next provider in the preset.

2. **Manage multiple subscription accounts from one CLI:** repeat `login` to add accounts to each provider pool, then inspect or remove them as needed:

   ```bash
   npx @subrouter/cli login anthropic
   npx @subrouter/cli login openai
   npx @subrouter/cli account list
   npx @subrouter/cli account remove openai me@example.com
   ```

3. **Create ranked model presets:** define the provider and model order once, then use the preset as `subrouter/<name>` in a supported harness:

   ```bash
   npx @subrouter/cli preset create work \
     --models 'anthropic/claude-opus-4-6,openai/gpt-5.5,xai/grok-4.6'
   npx @subrouter/cli preset show work
   ```

   The built-in `default` preset ranks the newest model for each configured provider. A user preset named `default` overrides it.

4. **Share cooldowns across every local process:** rate-limited accounts are stored in machine-wide cooldown state and skipped by all sessions. Use `status` to inspect the pool or clear cooldowns when an account is ready again:

   ```bash
   npx @subrouter/cli status
   npx @subrouter/cli cooldown clear
   ```

5. **Install the OpenCode integration:** register `@subrouter/opencode` without editing the OpenCode configuration by hand:

   ```bash
   npx @subrouter/cli install opencode
   ```

6. **Use subrouter as an AI SDK provider:** import `createSubrouter`, `RouterModel`, account storage helpers, and provider adapters from `@subrouter/cli` when building another personal harness integration.
