---
'@subrouter/cli': patch
---

Start streaming as soon as the provider answers, instead of waiting for the first token.

Grok thinking used to look hung because Subrouter held the stream until the first visible token. Native OpenCode xAI has no such wait.
