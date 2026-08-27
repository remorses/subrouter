<!-- Release history for the @subrouter/cli package. -->

# Changelog

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
