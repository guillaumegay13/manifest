---
'manifest': patch
---

Fix Chat Completions requests with function tools to Amazon Bedrock GPT cross-Region inference profiles (such as `us.openai.gpt-6-luna`). Bedrock Runtime applies a default reasoning effort and rejected it next to function tools, so these requests now send `reasoning_effort: 'none'`.
