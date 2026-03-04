import { ProviderClient } from './provider-client';

// Minimal mock of fetch to capture the request body
let lastFetchUrl: string;
let lastFetchBody: Record<string, unknown>;

beforeEach(() => {
  lastFetchUrl = '';
  lastFetchBody = {};

  // @ts-expect-error global fetch mock
  global.fetch = jest.fn(async (url: string, init: { body: string }) => {
    lastFetchUrl = url;
    lastFetchBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      body: null,
    };
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ProviderClient', () => {
  const client = new ProviderClient();

  describe('PROVIDER_MODEL_MAP', () => {
    it('translates deepseek-v3 to deepseek-chat for DeepSeek provider', async () => {
      await client.forward('deepseek', 'sk-test', 'deepseek-v3', {}, false);
      expect(lastFetchBody.model).toBe('deepseek-chat');
      expect(lastFetchUrl).toContain('api.deepseek.com');
    });

    it('translates deepseek-r1 to deepseek-reasoner for DeepSeek provider', async () => {
      await client.forward('deepseek', 'sk-test', 'deepseek-r1', {}, false);
      expect(lastFetchBody.model).toBe('deepseek-reasoner');
    });

    it('does not translate model names for other providers', async () => {
      await client.forward('openai', 'sk-test', 'deepseek-v3', {}, false);
      expect(lastFetchBody.model).toBe('deepseek-v3');
    });

    it('passes through unknown DeepSeek model names unchanged', async () => {
      await client.forward('deepseek', 'sk-test', 'deepseek-coder', {}, false);
      expect(lastFetchBody.model).toBe('deepseek-coder');
    });
  });
});
