---
'@subrouter/pi': patch
---

Strip Pi's self-identifying system prompt on Claude Pro/Max OAuth so Anthropic does not treat Pi as a third-party app.

Anthropic returns `400 invalid_request_error` with "Third-party apps now draw from your extra usage" when the request still contains "operating inside pi" or Pi's documentation block. The Claude Code identity block stays. Tools, cwd, skills, and `--append-system-prompt` stay.

Also close this plugin's Codex WebSockets on Pi session shutdown so `pi -p` can exit. The CLI bundle has a separate `pi-ai` copy, so its own dispose path cannot close sockets opened by `@subrouter/pi`.
