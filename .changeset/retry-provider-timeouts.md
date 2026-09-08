---
'@subrouter/cli': patch
---

Retry provider timeouts in OpenCode instead of killing the session.

Network failures such as `The operation timed out`, connect timeouts, and undici header/body timeouts are now thrown as retryable `APICallError`s. OpenCode waits and retries the same account. Subrouter does not rotate or cool down on a timeout.
