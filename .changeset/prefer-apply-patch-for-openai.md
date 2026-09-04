---
'@subrouter/cli': patch
'@subrouter/opencode': patch
---

Prefer OpenCode `apply_patch` when Subrouter routes to a GPT model.

OpenCode hides `edit`/`write` and loads the GPT/`codex` system prompt when the model id contains `gpt-` (and is not `gpt-4` or `gpt-oss`). Subrouter presets used names like `openai-only`, so GPT still received `edit`.

GPT presets now spoof a unique `gpt-*` api id. The provider maps that id back to the preset. Custom agent prompts also get the OpenCode apply_patch constraint when the live model is GPT.
