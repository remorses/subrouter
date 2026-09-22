---
'@subrouter/cli': patch
---

Advertise Claude Code `2.1.280` on Anthropic OAuth requests.

Anthropic returns 400 when the spoofed Claude Code client is older than `2.1.280`:

```
Claude Code 2.1.257 does not support this model; version 2.1.280 or newer is required.
```

The Anthropic adapter now sends `user-agent: claude-cli/2.1.280 (external, cli)`.
