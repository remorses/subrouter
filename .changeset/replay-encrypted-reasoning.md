---
'@subrouter/cli': patch
'@subrouter/opencode': patch
---

Replay previous thinking on Codex and Grok follow-up turns.

OpenCode v2 keeps reasoning by requesting `reasoning.encrypted_content` with `store: false`, then sending that blob back on the next message. Subrouter models use provider id `subrouter`, so OpenCode never applied those defaults.

RouterModel now copies `providerOptions.subrouter` onto the live SDK (`openai` / `xai` / `anthropic`) and always asks for encrypted reasoning. The OpenCode plugin also marks a preset as a reasoning model when the first live candidate is one, so thinking variants stay available.

Without the encrypted blob, Codex still drops summary-only thinking. That is required: `store: false` cannot point at `rs_*` ids.
