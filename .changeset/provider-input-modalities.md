---
'@subrouter/cli': patch
'@subrouter/opencode': patch
---

Fix PDF and other media inputs across subscription failover.

OpenCode model metadata now follows the input modalities published by models.dev instead of claiming every provider supports every attachment. Mixed presets advertise the union of their usable candidates, and Subrouter skips candidates that cannot accept the current prompt while preserving the configured ranking.

This prevents a PDF request that starts on OpenAI from failing after quota rotation reaches a provider without compatible PDF transport. It also preserves models.dev input-token limits in registered model metadata.
