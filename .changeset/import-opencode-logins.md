---
'@subrouter/cli': minor
'subrouter-website': patch
---

Add `subrouter import opencode` to copy matching OpenCode logins into Subrouter.

If you already signed in through OpenCode, this copies those tokens into `~/.subrouter/auth.json` instead of running each `subrouter login` again. Only providers Subrouter supports are imported. Existing accounts with the same identity are updated.

```bash
npx @subrouter/cli import opencode
npx @subrouter/cli import opencode --from ~/.local/share/opencode/auth.json
```

The auth file schema is at https://subrouter.org/auth.schema.json.
