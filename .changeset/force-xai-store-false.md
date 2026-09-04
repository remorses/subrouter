---
'@subrouter/cli': patch
---

Force Responses `store: false` on both the OpenAI and xAI AI SDK namespaces.

OpenCode only sets this for native `openai` / `xai` provider ids. Subrouter models use provider id `subrouter`, so both SDKs kept `store: true`. Long Grok replies then failed with `Response is too large to store`. Extra namespaced keys are ignored by other providers.
