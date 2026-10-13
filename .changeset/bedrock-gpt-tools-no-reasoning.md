---
'manifest': patch
---

Fix Chat Completions requests with function tools to Amazon Bedrock GPT cross-Region inference profiles (such as `us.openai.gpt-6-luna`). Bedrock Runtime defaults these models to reasoning and rejects that next to function tools, so a request with tools and no `reasoning_effort` now sends `none`, the OpenAI default. A `reasoning_effort` the caller sets is now forwarded instead of dropped.
