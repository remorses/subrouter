---
'@subrouter/cli': patch
---

Honor the provider `retry-after` period instead of waiting at least 5 minutes.

If a 429 or usage-limit response includes `retry-after` or `retry-after-ms`, that period is now the cooldown. A 30 second retry-after cools for 30 seconds. `Retry-After: 0` means the account can be tried again on the next request. A past HTTP date also means retry now. Missing or invalid headers still default to 5 minutes. Exhausted balances still cool for 6 hours.
