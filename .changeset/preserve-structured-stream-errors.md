---
'@subrouter/cli': patch
---

Preserve structured provider stream errors instead of displaying `[object Object]`.

OpenAI Responses API errors now retain their nested message and original payload, so Subrouter can classify rate limits, record the account cooldown, and report the real provider error.
