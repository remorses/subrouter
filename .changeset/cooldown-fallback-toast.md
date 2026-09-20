---
'@subrouter/opencode': patch
---

Show the cooldown fallback route as a TUI toast instead of injecting a session message.

When a preferred subscription is rate limited and the request continues on a lower-ranked model, the OpenCode plugin now surfaces the notice through `client.tui.showToast`, the same channel other OpenCode plugins use for notifications. Previously it wrote the notice into the session with `session.prompt`, which persisted a `role: user` message and could enter model context. The toast is display-only: it never becomes a fake user or assistant message and never reaches the model.

`tui.toast.show` is a global event with no session field, so the plugin appends the OpenCode session id to the toast text. Kimaki routes the toast to the matching Discord thread by that marker and strips it before display; plain OpenCode TUI shows the toast for the active session. Notices are still deduplicated per session for the preferred model's cooldown window.
