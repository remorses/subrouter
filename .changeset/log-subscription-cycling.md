---
'@subrouter/cli': minor
'@subrouter/opencode': minor
'@subrouter/pi': patch
---

Log which subscription is tried and which one fails over when OpenCode prints logs.

OpenCode `--print-logs` now shows cycle events from `client.app.log`:

```
trying openai/gpt-5.5 #1 (elisaderossi07@gmail.com)
failover openai/gpt-5.5 #1 (elisaderossi07@gmail.com) error="The usage limit has been reached"
trying openai/gpt-5.5 #2 (t.de.rossi.01@gmail.com)
```

The router never writes these to stdout or stderr. OpenCode owns the sink. Pi has no log API, so those runs stay silent.
