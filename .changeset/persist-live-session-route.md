---
'@subrouter/cli': patch
'@subrouter/opencode': patch
'@subrouter/pi': patch
---

Persist the in-flight Subrouter route per session so other processes can read the live model.

`resolveLiveModel({ preset, sessionID })` returns the provider/model that accepted the current run. OpenCode's powered-by system line uses that value. After failover, later calls in the same session keep showing the fallback until the session goes idle.
