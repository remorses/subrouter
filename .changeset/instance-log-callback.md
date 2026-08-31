---
'@subrouter/cli': patch
'@subrouter/opencode': patch
'@subrouter/pi': patch
---

Prevent Subrouter from writing to stdout or stderr when OpenCode loads the plugin or routes a request.

Runtime logs now use a `log` callback passed through OpenCode provider options into `createSubrouter()` and each `RouterModel`. Remove the process-wide `globalThis` log sink, so separate harnesses and provider instances cannot leak log destinations into each other.
