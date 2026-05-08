import {
  BedrockCredentialError,
  bedrockStreamToSse,
  buildBedrockBody,
  forwardToBedrock,
  type BedrockClientLike,
} from './bedrock-transport';
import { packBedrockCredential } from './bedrock-credential';

const VALID_CRED = packBedrockCredential({
  accessKeyId: 'AKIA',
  secretAccessKey: 'secret',
  region: 'us-east-1',
});

describe('buildBedrockBody', () => {
  it('strips model and stream and injects anthropic_version', () => {
    const out = buildBedrockBody({
      model: 'irrelevant',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    });
    expect(out).toEqual({
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
      anthropic_version: 'bedrock-2023-05-31',
    });
  });

  it('overwrites a caller-supplied anthropic_version', () => {
    const out = buildBedrockBody({
      anthropic_version: '2023-06-01',
      messages: [],
    });
    expect(out.anthropic_version).toBe('bedrock-2023-05-31');
  });
});

describe('bedrockStreamToSse', () => {
  async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    let out = '';
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return out;
      if (value) out += decoder.decode(value);
    }
  }

  function asBytes(json: object): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(json));
  }

  async function* makeIterable(parts: Array<{ chunk?: { bytes?: Uint8Array } }>) {
    for (const part of parts) {
      yield part as never;
    }
  }

  it('wraps each chunk in event:/data: framing keyed by the JSON `type`', async () => {
    const stream = bedrockStreamToSse(
      makeIterable([
        { chunk: { bytes: asBytes({ type: 'message_start', message: { id: '1' } }) } },
        { chunk: { bytes: asBytes({ type: 'content_block_delta' }) } },
      ]),
    );
    const text = await collect(stream);
    expect(text).toContain('event: message_start\n');
    expect(text).toContain('"id":"1"');
    expect(text).toContain('event: content_block_delta\n');
    expect(text.endsWith('\n\n')).toBe(true);
  });

  it('falls back to event: message when type is missing', async () => {
    const stream = bedrockStreamToSse(
      makeIterable([{ chunk: { bytes: asBytes({ foo: 'bar' }) } }]),
    );
    const text = await collect(stream);
    expect(text.startsWith('event: message\n')).toBe(true);
  });

  it('skips chunks whose bytes are not parseable JSON', async () => {
    const garbage = new TextEncoder().encode('not json');
    const stream = bedrockStreamToSse(
      makeIterable([{ chunk: { bytes: garbage } }, { chunk: { bytes: asBytes({ type: 'ok' }) } }]),
    );
    const text = await collect(stream);
    expect(text).toContain('event: ok\n');
    expect(text).not.toContain('not json');
  });

  it('errors the stream on Bedrock service exceptions', async () => {
    async function* bad() {
      yield { throttlingException: { message: 'slow down' } } as never;
    }
    const stream = bedrockStreamToSse(bad());
    await expect(collect(stream)).rejects.toThrow('slow down');
  });

  it('errors the stream when the iterator throws', async () => {
    async function* failing() {
      yield { chunk: { bytes: new TextEncoder().encode('{}') } } as never;
      throw new Error('iterator boom');
    }
    const stream = bedrockStreamToSse(failing());
    await expect(collect(stream)).rejects.toThrow('iterator boom');
  });

  it('uses generic messages when service exceptions omit a message', async () => {
    async function* unnamed() {
      yield { internalServerException: {} } as never;
    }
    await expect(collect(bedrockStreamToSse(unnamed()))).rejects.toThrow(
      'Bedrock internal server error',
    );
  });

  it.each([
    ['modelStreamErrorException', 'Bedrock model stream error'],
    ['modelTimeoutException', 'Bedrock model timeout'],
    ['serviceUnavailableException', 'Bedrock service unavailable'],
    ['validationException', 'Bedrock validation error'],
  ])('surfaces %s with default message', async (key, msg) => {
    async function* errored() {
      yield { [key]: {} } as never;
    }
    await expect(collect(bedrockStreamToSse(errored()))).rejects.toThrow(msg);
  });

  it('skips empty iterator values and undefined chunks before completing', async () => {
    async function* mixed() {
      yield undefined as never;
      yield { chunk: undefined } as never;
    }
    const text = await collect(bedrockStreamToSse(mixed()));
    expect(text).toBe('');
  });

  it('cancel propagates to the underlying iterator return', async () => {
    const returnSpy = jest.fn().mockResolvedValue({ value: undefined, done: true });
    const iterable: AsyncIterable<{ chunk?: { bytes?: Uint8Array } }> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise(() => {}),
          return: returnSpy,
        };
      },
    };
    const stream = bedrockStreamToSse(iterable as never);
    await stream.cancel();
    expect(returnSpy).toHaveBeenCalled();
  });

  it('cancel is a no-op when the iterator has no return method', async () => {
    const iterable: AsyncIterable<{ chunk?: { bytes?: Uint8Array } }> = {
      [Symbol.asyncIterator]() {
        return { next: () => new Promise(() => {}) } as AsyncIterator<{
          chunk?: { bytes?: Uint8Array };
        }>;
      },
    };
    const stream = bedrockStreamToSse(iterable as never);
    await expect(stream.cancel()).resolves.toBeUndefined();
  });
});

describe('forwardToBedrock', () => {
  function fakeClient(impl: Partial<BedrockClientLike>): BedrockClientLike {
    return impl as BedrockClientLike;
  }

  it('throws BedrockCredentialError for malformed credentials', async () => {
    await expect(
      forwardToBedrock({
        apiKey: 'not-json',
        model: 'anthropic.claude-3-5',
        body: { messages: [] },
        stream: false,
      }),
    ).rejects.toThrow(BedrockCredentialError);
  });

  it('returns a JSON Response for non-streaming requests', async () => {
    const sentBody = { id: 'msg_1', type: 'message', content: [] };
    const factory = () =>
      fakeClient({
        send: jest.fn().mockResolvedValue({
          body: new TextEncoder().encode(JSON.stringify(sentBody)),
          contentType: 'application/json',
        }),
      });
    const res = await forwardToBedrock({
      apiKey: VALID_CRED,
      model: 'anthropic.claude',
      body: { messages: [] },
      stream: false,
      clientFactory: factory,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual(sentBody);
  });

  it('returns an SSE Response for streaming requests', async () => {
    async function* events() {
      yield {
        chunk: { bytes: new TextEncoder().encode(JSON.stringify({ type: 'message_start' })) },
      } as never;
    }
    const factory = () =>
      fakeClient({
        send: jest.fn().mockResolvedValue({ body: events(), contentType: 'text/event-stream' }),
      });
    const res = await forwardToBedrock({
      apiKey: VALID_CRED,
      model: 'anthropic.claude',
      body: { messages: [] },
      stream: true,
      clientFactory: factory,
    });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: message_start\n');
  });

  it('throws when the SDK returns no body', async () => {
    const factory = () => fakeClient({ send: jest.fn().mockResolvedValue({}) });
    await expect(
      forwardToBedrock({
        apiKey: VALID_CRED,
        model: 'anthropic.claude',
        body: { messages: [] },
        stream: false,
        clientFactory: factory,
      }),
    ).rejects.toThrow('Bedrock response had no body');
  });

  it('throws when streaming SDK returns no body', async () => {
    const factory = () => fakeClient({ send: jest.fn().mockResolvedValue({}) });
    await expect(
      forwardToBedrock({
        apiKey: VALID_CRED,
        model: 'anthropic.claude',
        body: { messages: [] },
        stream: true,
        clientFactory: factory,
      }),
    ).rejects.toThrow('Bedrock streaming response had no body');
  });

  it('passes the abort signal through to the SDK send call', async () => {
    const send = jest.fn().mockResolvedValue({
      body: new TextEncoder().encode('{}'),
      contentType: 'application/json',
    });
    const factory = () => fakeClient({ send });
    const ctrl = new AbortController();
    await forwardToBedrock({
      apiKey: VALID_CRED,
      model: 'anthropic.claude',
      body: { messages: [] },
      stream: false,
      signal: ctrl.signal,
      clientFactory: factory,
    });
    expect(send).toHaveBeenCalledWith(expect.anything(), { abortSignal: ctrl.signal });
  });

  it('forwards session token credentials when present', async () => {
    const captured: { region?: string; credentials?: unknown }[] = [];
    const factory = (region: string, credentials: unknown) => {
      captured.push({ region, credentials });
      return fakeClient({
        send: jest.fn().mockResolvedValue({
          body: new TextEncoder().encode('{}'),
          contentType: 'application/json',
        }),
      });
    };
    const apiKey = packBedrockCredential({
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
      region: 'us-west-2',
      sessionToken: 'st',
    });
    await forwardToBedrock({
      apiKey,
      model: 'anthropic.claude',
      body: { messages: [] },
      stream: false,
      clientFactory: factory,
    });
    expect(captured[0].region).toBe('us-west-2');
    expect(captured[0].credentials).toEqual({
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
      sessionToken: 'st',
    });
  });
});
