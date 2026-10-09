---
'@subrouter/opencode': minor
---

Migrate the OpenCode plugin to the v2 plugin API.

Register `@subrouter/opencode` with the v2 `plugins` key:

```json
{
  "plugins": ["@subrouter/opencode"]
}
```

The plugin is now one default export: `Plugin.define({ id: 'subrouter' })`. It injects the `subrouter` catalog through `aisdk:file://...`, pins tool follow-ups to the session until execution ends, and still fails over Anthropic 429s to OpenCode Go.

**File editing.** OpenCode v2 selects its GPT prompt and `patch` tool from the public catalog model id. Prefix a GPT-only preset with `gpt-` to opt in while keeping the preset name stable:

```bash
subrouter preset create gpt-codex --models 'openai/gpt-5.5#high'
```

Mixed-provider presets should not use the prefix because OpenCode keeps the GPT prompt and tools after Subrouter changes providers.

**Login.** OpenCode login only covers OAuth subscriptions: Anthropic, OpenAI, xAI, GitHub Copilot, and Poe. API-key providers stay on `subrouter login`.

**Cooldown notices.** OpenCode v2 has no UI-only ignored-notice API, so Subrouter no longer posts `Subrouter: Using ... because ... is rate limited.` into the session. Route logs still exist when a harness supplies a silent logger.
