---
'@subrouter/cli': patch
'@subrouter/pi': patch
---

Send `x-opencode-session` on OpenCode Go inference requests.

OpenCode Go now requires a stable per-conversation id on every API call. Subrouter already has the harness session id (`x-subrouter-session-id` from OpenCode, `sessionId` from Pi). RouterModel and the Pi plugin now copy that value onto `x-opencode-session` for `opencode-go` candidates. Calls without a harness session id get a random UUID so the request still succeeds.

```ts
// OpenCode plugin already sets the harness session header
output.headers['x-subrouter-session-id'] = input.sessionID

// RouterModel now forwards it to OpenCode Go
headers.set('x-opencode-session', sessionId)
```
