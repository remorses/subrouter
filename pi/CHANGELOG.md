<!-- Release history for the @subrouter/pi package. -->

# Changelog

## 0.1.0

1. **Use Subrouter presets as native Pi models:** install the extension once, then select the same `subrouter/<preset>` model names used by OpenCode:

   ```bash
   pi install npm:@subrouter/pi
   pi --model subrouter/default
   ```

2. **Route across ten personal subscription providers:** Pi can use Claude Pro/Max, ChatGPT Plus/Pro, SuperGrok, opencode Go, GitHub Copilot, Poe, MiniMax, Kimi Code, Z.ai, and Alibaba Coding Plan accounts stored in `~/.subrouter`.

3. **Keep Pi's native provider protocols and streams:** Subrouter only selects the account and model. Pi builds each provider request and emits its native events unchanged. A rate or usage limit rotates to another candidate only before output starts, so partial responses are never combined across providers.

4. **Reuse ChatGPT Codex WebSockets:** Pi's native Codex transport can cache account-scoped WebSocket connections across turns and use its built-in SSE fallback when a socket is unavailable.
