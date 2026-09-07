---
'@subrouter/cli': minor
'@subrouter/opencode': minor
'@subrouter/pi': minor
---

Pin reasoning effort on preset entries with `#variant`.

`preset create` now accepts ranked entries like `openai/gpt-5.5#high` and `anthropic/claude-opus-4-6#max`. The variant is checked against models.dev `reasoning_options` before save. Unknown or unsupported variants fail at create time.

```bash
npx @subrouter/cli preset create work --models 'anthropic/claude-opus-4-6#max,openai/gpt-5.5#high'
```

OpenCode applies that pin on the live SDK unless the session already set `--variant` or `subrouter/<name>#high`. If the live fallback does not list that session variant, Subrouter uses the candidate pin or the provider default instead of sending an unsupported effort. The plugin also publishes the first live candidate's variants so the OpenCode picker can change effort per session. Pi maps the same pin onto native `reasoning`. Session reasoning still wins over the preset pin.
