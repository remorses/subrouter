<!-- Release history for the @subrouter/opencode package. -->

# Changelog

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
