---
'manifest': patch
---

Keep Gemini streams consistent across events: one completion id, distinct tool-call indices, and a `tool_calls` finish reason when a tool call came in an earlier event.
