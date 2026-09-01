---
'@subrouter/cli': patch
'@subrouter/opencode': patch
'@subrouter/pi': patch
---

Keep each user message on the provider, model, and account that accepted it. Tool-result follow-ups no longer return to a higher-ranked subscription when its cooldown expires during the same agent run, which prevents later route switches and their extra cache-write spend. New user messages still start from the preset ranking.
