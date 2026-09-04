---
'@subrouter/cli': patch
---

Shorten two cooldown defaults so accounts come back sooner after quota and capacity failures.

- **Balance / quota exhausted** (`402`, quota-exhausted text) now cools for **10 minutes** instead of 6 hours.
- **Overloaded / at capacity** messages now cool for **1 minute** instead of the 5 minute default.

`retry-after` / `retry-after-ms` still win when the provider sends them. Missing headers on a normal `429` still default to 5 minutes.
