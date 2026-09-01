<!-- Release history for the @subrouter/pi package. -->

# Changelog

## 0.2.1

1. **Keep Claude Pro/Max OAuth requests on subscription usage.** The extension removes Pi's self-identifying system prompt and documentation block before Anthropic receives the request. The Claude Code identity block, tools, working directory, skills, and `--append-system-prompt` remain intact, so Anthropic no longer rejects the request as a third-party app that requires extra usage.

2. **Let `pi -p` exit after a Codex turn.** The extension now closes its own Codex WebSockets on Pi session shutdown.

3. **Keep runtime logging isolated and silent.** Subrouter no longer writes to stdout or stderr when Pi loads the extension or routes a request. Separate harness and provider instances cannot leak log destinations into each other.

## 0.2.0

1. **Show the provider as `subrouter.org`** in Pi, matching OpenCode. Preset model ids stay `subrouter/<preset>`.

2. **Use `opencode-go` for the OpenCode Go plan.** Pi now has a native OpenAI-compatible provider for that id. Existing `opencode` accounts are copied to `opencode-go` on first load.

## 0.1.0

1. **Use Subrouter presets as native Pi models:** install the extension once, then select the same `subrouter/<preset>` model names used by OpenCode:

   ```bash
   pi install npm:@subrouter/pi
   pi --model subrouter/default
   ```

2. **Route across ten personal subscription providers:** Pi can use Claude Pro/Max, ChatGPT Plus/Pro, SuperGrok, opencode Go, GitHub Copilot, Poe, MiniMax, Kimi Code, Z.ai, and Alibaba Coding Plan accounts stored in `~/.subrouter`.

3. **Keep Pi's native provider protocols and streams:** Subrouter only selects the account and model. Pi builds each provider request and emits its native events unchanged. A rate or usage limit rotates to another candidate only before output starts, so partial responses are never combined across providers.

4. **Reuse ChatGPT Codex WebSockets:** Pi's native Codex transport can cache account-scoped WebSocket connections across turns and use its built-in SSE fallback when a socket is unavailable.
