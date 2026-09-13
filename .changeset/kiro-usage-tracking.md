---
'manifest': patch
---

Kiro requests record real token usage instead of always logging zeros. Usage now comes from the `contextUsageEvent` Kiro actually emits (with `metadataEvent` as a fallback), is estimated from `contextUsagePercentage` when the stream carries no per-token counts, and keeps the cache read/write breakdown so `cache_read_tokens` and `cache_creation_tokens` populate the request log. Unknown Kiro event types are logged at debug.
