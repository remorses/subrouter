---
'@subrouter/cli': minor
'subrouter-website': patch
---

Store tokens in `~/.subrouter/auth.json` and keep presets, cooldowns, and live routes in `~/.subrouter/config.json`.

Older combined `config.json` files are split on the next write. Editors can autocomplete both files from `$schema`:

- https://subrouter.org/auth.schema.json
- https://subrouter.org/config.schema.json

https://subrouter.org/schema.json still serves the config schema.
