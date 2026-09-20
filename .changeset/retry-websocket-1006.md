---
'@subrouter/cli': patch
---

Retry OpenAI WebSocket 1006 drops in OpenCode instead of rotating the account.

A `code 1006` abnormal WebSocket close (`OpenAI WebSocket failed: closed before response completed`) is a transient network failure, like a request timeout, not a provider quota or auth rejection. Subrouter no longer classifies it as rotate-worthy and no longer cools down the account for 5 minutes. It is now wrapped as a retryable `APICallError`, so OpenCode retries the turn on the same subscription with its normal backoff. A `code 1008` policy-violation close is still terminal.
