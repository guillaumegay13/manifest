---
'manifest': minor
---

Add AWS Bedrock as a first-class provider for Anthropic Claude models. Reuses the existing Anthropic adapter for request/response conversion and dispatches via `@aws-sdk/client-bedrock-runtime` so SigV4 signing and binary eventstream handling stay inside the SDK. The Routing UI exposes a new tile with multi-field credential inputs (Access Key ID + Secret Access Key + optional Session Token + AWS Region). Model discovery merges `ListFoundationModels` with system-defined cross-region inference profiles so newer Claude models (which require profile IDs) appear automatically.
