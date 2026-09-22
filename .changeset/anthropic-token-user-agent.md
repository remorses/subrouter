---
'@subrouter/cli': patch
---

Fix Claude Pro/Max login and token refresh inside OpenCode.

Inside OpenCode, Bun sends `User-Agent: opencode/<version>` by default. The Claude OAuth token endpoint answers that user-agent with a fake rate limit, so every login and every token refresh failed:

```
token endpoint returned 429: {"error": {"type": "rate_limit_error", "message": "Rate limited. Please try again later."}}
```

Harnesses like the kimaki Discord bot showed this as `Authorization code was invalid or expired`. Token requests now send the Claude Code user-agent, the same one Anthropic API calls already use.
