/**
 * AWS Bedrock transport for Anthropic-format requests.
 *
 * Manifest's proxy pipeline already speaks Anthropic Messages format end to
 * end (see `anthropic-adapter.ts`). Bedrock hosts Claude models and accepts
 * the same JSON shape as `api.anthropic.com/v1/messages` — the only
 * differences are at the transport layer: SigV4 signing, `model` lives on
 * the URL path, and `anthropic_version` must be explicitly declared inside
 * the body. We delegate signing + eventstream parsing to
 * `@aws-sdk/client-bedrock-runtime`, then wrap the SDK's output into a
 * standard `Response` so the rest of the proxy (response handler, stream
 * transformer, message recorder) can process it as a normal Anthropic
 * upstream.
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
  type InvokeModelCommandOutput,
  type InvokeModelWithResponseStreamCommandOutput,
  type ResponseStream,
} from '@aws-sdk/client-bedrock-runtime';

import { parseBedrockCredential } from './bedrock-credential';

const BEDROCK_ANTHROPIC_VERSION = 'bedrock-2023-05-31';

export interface BedrockForwardOptions {
  apiKey: string;
  model: string;
  body: Record<string, unknown>;
  stream: boolean;
  signal?: AbortSignal;
  /** Override the default SDK constructor — used in tests. */
  clientFactory?: (region: string, credentials: BedrockClientCredentials) => BedrockClientLike;
}

export interface BedrockClientCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * Minimal slice of `BedrockRuntimeClient` we depend on. Defining it here
 * keeps tests free from having to construct the real client.
 */
export interface BedrockClientLike {
  send(
    command: InvokeModelCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<InvokeModelCommandOutput>;
  send(
    command: InvokeModelWithResponseStreamCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<InvokeModelWithResponseStreamCommandOutput>;
}

export class BedrockCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BedrockCredentialError';
  }
}

export const defaultBedrockRuntimeClientFactory = (
  region: string,
  credentials: BedrockClientCredentials,
): BedrockClientLike => {
  return new BedrockRuntimeClient({
    region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
    },
  });
};

/**
 * Strip fields that Bedrock rejects and inject the bedrock-specific
 * version marker. The Anthropic adapter sets `model`, `stream`, and
 * `anthropic-version` (header); Bedrock takes none of these on the body
 * level — the model id is part of the URL, streaming is implied by the
 * command type, and `anthropic_version` belongs in the JSON body.
 */
export function buildBedrockBody(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'model' || key === 'stream') continue;
    out[key] = value;
  }
  out.anthropic_version = BEDROCK_ANTHROPIC_VERSION;
  return out;
}

const encoder = new TextEncoder();

/** Encode an Anthropic SSE event in the wire format the proxy pipeline expects. */
function encodeSseEvent(eventType: string, payload: string): Uint8Array {
  return encoder.encode(`event: ${eventType}\ndata: ${payload}\n\n`);
}

/**
 * Bridge a Bedrock `ResponseStream` async iterable into a `ReadableStream`
 * of SSE bytes. Each Bedrock chunk's `bytes` field already contains a
 * single Anthropic SSE event JSON object — we just need to wrap it in the
 * `event:`/`data:` framing the existing parser consumes.
 */
export function bedrockStreamToSse(
  iterable: AsyncIterable<ResponseStream>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const { value, done } = await iterator.next();
          if (done) {
            controller.close();
            return;
          }
          if (!value) continue;
          if (value.chunk?.bytes) {
            const text = decoder.decode(value.chunk.bytes);
            let parsed: { type?: unknown };
            try {
              parsed = JSON.parse(text) as { type?: unknown };
            } catch {
              // Bedrock-side garbage — skip and pull the next chunk.
              continue;
            }
            const eventType = typeof parsed.type === 'string' ? parsed.type : 'message';
            controller.enqueue(encodeSseEvent(eventType, text));
            return;
          }
          const errorEntry = extractStreamError(value);
          if (errorEntry) {
            controller.error(new Error(errorEntry));
            return;
          }
          // Unknown member shape: keep pulling.
        }
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      if (typeof iterator.return === 'function') {
        await iterator.return();
      }
    },
  });
}

function extractStreamError(value: ResponseStream): string | null {
  if (value.internalServerException) {
    return value.internalServerException.message ?? 'Bedrock internal server error';
  }
  if (value.modelStreamErrorException) {
    return value.modelStreamErrorException.message ?? 'Bedrock model stream error';
  }
  if (value.modelTimeoutException) {
    return value.modelTimeoutException.message ?? 'Bedrock model timeout';
  }
  if (value.serviceUnavailableException) {
    return value.serviceUnavailableException.message ?? 'Bedrock service unavailable';
  }
  if (value.throttlingException) {
    return value.throttlingException.message ?? 'Bedrock throttling';
  }
  if (value.validationException) {
    return value.validationException.message ?? 'Bedrock validation error';
  }
  return null;
}

/**
 * Forward an already-Anthropic-shaped request to Bedrock and return a
 * `Response` whose body looks like an Anthropic upstream's: SSE for
 * streaming, JSON for non-streaming.
 */
export async function forwardToBedrock(opts: BedrockForwardOptions): Promise<Response> {
  const credential = parseBedrockCredential(opts.apiKey);
  if (!credential) {
    throw new BedrockCredentialError('Invalid AWS Bedrock credentials');
  }

  const factory = opts.clientFactory ?? defaultBedrockRuntimeClientFactory;
  const client = factory(credential.region, {
    accessKeyId: credential.accessKeyId,
    secretAccessKey: credential.secretAccessKey,
    ...(credential.sessionToken ? { sessionToken: credential.sessionToken } : {}),
  });

  const bedrockBody = buildBedrockBody(opts.body);
  const bodyBytes = encoder.encode(JSON.stringify(bedrockBody));

  if (opts.stream) {
    const command = new InvokeModelWithResponseStreamCommand({
      modelId: opts.model,
      contentType: 'application/json',
      accept: 'application/json',
      body: bodyBytes,
    });
    const response = await client.send(command, opts.signal ? { abortSignal: opts.signal } : {});
    if (!response.body) {
      throw new Error('Bedrock streaming response had no body');
    }
    const sseStream = bedrockStreamToSse(response.body);
    return new Response(sseStream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  const command = new InvokeModelCommand({
    modelId: opts.model,
    contentType: 'application/json',
    accept: 'application/json',
    body: bodyBytes,
  });
  const response = await client.send(command, opts.signal ? { abortSignal: opts.signal } : {});
  if (!response.body) {
    throw new Error('Bedrock response had no body');
  }
  // Cast to a generic Uint8Array to satisfy DOM's BodyInit signature; the
  // AWS SDK types declare a parameterized variant that the lib.dom union
  // doesn't accept directly.
  return new Response(new Uint8Array(response.body) as unknown as BodyInit, {
    status: 200,
    headers: { 'content-type': response.contentType ?? 'application/json' },
  });
}
