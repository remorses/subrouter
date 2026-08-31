---
'@subrouter/cli': patch
---

Retry OpenCode turns when a routed subscription fails after the stream starts but before it produces semantic output.

OpenAI WebSocket code 1006 disconnects now cool down the failed account and reach OpenCode as retryable API errors. Routed 401, 403, 429, usage-limit, and spending-limit failures use the same safe retry path, so OpenCode can start the turn again on the next available subscription instead of ending the session.

Failures after text, reasoning, or tool output still cool down the account, but do not replay the turn. This prevents duplicate output and repeated tool side effects.
