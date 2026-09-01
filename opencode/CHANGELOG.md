<!-- Release history for the @subrouter/opencode package. -->

# Changelog

## 0.4.0

1. **Show when a message starts on a fallback model.** If the preferred subscription is already rate limited, OpenCode adds an ignored notice after the turn finishes:

   ```text
   Subrouter: openai/gpt-5.5 was rate limited. This message started with anthropic/claude-opus-4-6.
   ```

   The notice stays visible in session history, is never sent to the model, and cannot start another model turn. Preset labels now stay stable, such as `build`, instead of showing a stale startup candidate.

2. **Route PDFs and other media through compatible fallbacks.** OpenCode model metadata now uses the input modalities published by models.dev instead of claiming every provider supports every attachment. Mixed presets advertise the union of usable candidates, and Subrouter skips candidates that cannot accept the current prompt while preserving the configured ranking. Registered metadata also preserves models.dev input-token limits.

3. **Keep plugin runtime logs inside OpenCode.** Subrouter no longer writes to stdout or stderr when OpenCode loads the plugin or routes a request. Logs use an instance-specific callback passed through provider options, so separate provider instances cannot leak log destinations into each other.

## 0.3.0

1. **Log which subscription is tried** when OpenCode prints logs:

   ```bash
   opencode run --print-logs --log-level INFO -m subrouter/default 'Reply with one word: ping'
   ```

   ```
   trying openai/gpt-5.5 #1 (work@x.com)
   failover openai/gpt-5.5 #1 (work@x.com) error="The usage limit has been reached"
   trying openai/gpt-5.5 #2 (personal@x.com)
   ```

2. **Show the live routed model** as `subrouter.org`. Preset names include the current candidate, for example `default (claude-opus-4-6)`. Context limits follow that candidate. The powered-by system line uses the live `provider/model` id, not the preset name.

3. **Wait out cooldowns instead of dying** when every Subrouter account is cooling down. OpenCode receives a retryable 429 with `retry-after` and continues the session after the wait.

4. **Pass image and PDF inputs through OpenCode** so attachments reach the routed provider.

5. **Use `opencode-go` for the OpenCode Go plan.** Existing `opencode` accounts are copied to `opencode-go` on first load.

## 0.2.0

1. **Add subscriptions without leaving OpenCode:** the plugin now provides an auth flow for every Subrouter provider. Run OpenCode's auth login, choose Subrouter, then select the subscription to add:

   ```bash
   opencode auth login --provider subrouter
   ```

   Browser, device-code, and pasted-key flows all write to the shared `~/.subrouter` account pool.

2. **Use ten subscription providers through one model:** OpenCode presets can now route across Claude Pro/Max, ChatGPT Plus/Pro, SuperGrok, opencode Go, GitHub Copilot, Poe, MiniMax, Kimi Code, Z.ai, and Alibaba Coding Plan accounts.

3. **Reuse ChatGPT Codex WebSockets by OpenCode session:** the plugin supplies session affinity to the router so normal ChatGPT requests can share a cached WebSocket. Title-generation requests stay on HTTP, and failover never replays a stream after user-visible output starts.

4. **Register the plugin through OpenCode configuration:** add the package directly to `~/.config/opencode/opencode.json` instead of using the removed CLI installer:

   ```json
   {
     "plugin": ["@subrouter/opencode"]
   }
   ```

## 0.1.0

1. **Use every subrouter preset as an OpenCode model:** the plugin registers the `subrouter` provider and exposes the built-in `subrouter/default` model plus each user preset as `subrouter/<preset>`.

   ```bash
   npx @subrouter/cli install opencode
   ```

   Restart OpenCode, then select `subrouter/default` or another configured preset.

2. **Fail over through the complete OpenCode pipeline:** when a subscription reaches a rate or usage limit, the request moves to the next eligible account or provider. OpenCode receives the underlying provider response without cross-provider wire-format translation.

3. **Load new presets on restart:** presets created with `npx @subrouter/cli preset create` are added to OpenCode's model list the next time OpenCode starts.
