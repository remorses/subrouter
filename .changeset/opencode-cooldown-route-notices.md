---
'@subrouter/cli': patch
'@subrouter/opencode': patch
---

Show when an OpenCode message starts on a fallback model because the preferred subscription was rate limited.

After the turn finishes, OpenCode adds the routing information to the session as an ignored notice. The notice remains visible in session history but is never sent to the model or allowed to start another model turn.

Preset labels now stay stable, such as `build`, instead of showing a stale startup candidate such as `build (grok-4.6)`.
