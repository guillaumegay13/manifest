---
'manifest': patch
---

Kiro requests record real token usage instead of always logging zeros. Live `GenerateAssistantResponse` streams carry no per-token counts (only `assistantResponseEvent` content and a credit-based `meteringEvent`), so when neither an explicit `tokenUsage` block nor a `contextUsageEvent.contextUsagePercentage` is present, prompt and completion tokens are estimated from the request conversation and the emitted text and marked `estimated: true`. The cache read/write breakdown is still preserved so `cache_read_tokens` and `cache_creation_tokens` populate the request log when Kiro reports them. Unknown Kiro event types are logged at debug.
