import { PROVIDER_PROFILES, resolveProfile } from './provider-profiles';
import { PROVIDER_ENDPOINTS } from './provider-endpoints';

describe('resolveProfile — OpenAI profile (migration spike)', () => {
  it('returns null for providers not yet migrated to a profile', () => {
    expect(resolveProfile('mistral', { model: 'mistral-large-latest' })).toBeNull();
  });

  it('resolves the base OpenAI profile to /v1/chat/completions', () => {
    const r = resolveProfile('openai', { model: 'gpt-4o-mini' });
    expect(r).not.toBeNull();
    expect(r!.endpointKey).toBe('openai');
    expect(r!.path).toBe('/v1/chat/completions');
    expect(r!.baseUrl).toBe('https://api.openai.com');
  });

  it('routes subscription auth to the Codex backend', () => {
    const r = resolveProfile('openai', { authType: 'subscription', model: 'gpt-5' });
    expect(r!.endpointKey).toBe('openai-subscription');
    expect(r!.path).toBe('/codex/responses');
  });

  it('routes apiMode=responses to the Responses API', () => {
    const r = resolveProfile('openai', { apiMode: 'responses', model: 'gpt-4o' });
    expect(r!.endpointKey).toBe('openai-responses');
    expect(r!.path).toBe('/v1/responses');
  });

  it('routes responses-only models (o1-pro) to the Responses API', () => {
    const r = resolveProfile('openai', { model: 'o1-pro' });
    expect(r!.endpointKey).toBe('openai-responses');
  });

  it('strips the vendor prefix when matching responses-only models', () => {
    const r = resolveProfile('openai', { model: 'openai/gpt-5-codex' });
    expect(r!.endpointKey).toBe('openai-responses');
  });

  it('keeps codex-mini-latest on the base chat endpoint (negative lookahead)', () => {
    const r = resolveProfile('openai', { model: 'codex-mini-latest' });
    expect(r!.endpointKey).toBe('openai');
  });

  it('gives subscription precedence over responses routing', () => {
    const r = resolveProfile('openai', {
      authType: 'subscription',
      apiMode: 'responses',
      model: 'o1-pro',
    });
    expect(r!.endpointKey).toBe('openai-subscription');
  });

  it('declares OpenAI request quirks as data, not engine branches', () => {
    const quirks = PROVIDER_PROFILES.openai.quirks;
    expect(quirks?.maxCompletionTokensModels?.test('o1')).toBe(true);
    expect(quirks?.maxCompletionTokensModels?.test('gpt-5')).toBe(true);
    expect(quirks?.maxCompletionTokensModels?.test('gpt-4o')).toBe(false);
    expect(quirks?.streamUsageOptions).toBe(true);
  });

  it('decomposes vendor (transport) from wire shape (wireApi)', () => {
    const base = resolveProfile('openai', { model: 'gpt-4o' })!;
    expect(base.transport).toBe('openai');
    expect(base.wireApi).toBe('chat_completions');

    const responses = resolveProfile('openai', { apiMode: 'responses', model: 'gpt-4o' })!;
    expect(responses.transport).toBe('openai');
    expect(responses.wireApi).toBe('responses');

    const subscription = resolveProfile('openai', { authType: 'subscription', model: 'gpt-4o' })!;
    expect(subscription.transport).toBe('openai');
    expect(subscription.wireApi).toBe('responses');
  });

  it("reconstructs the registry's legacy format from (transport, wireApi) (parity)", () => {
    // The legacy `ProviderEndpoint.format` collapses these two axes: an
    // OpenAI-vendor endpoint speaking the Responses API is tagged 'chatgpt'.
    const toLegacyFormat = (transport: string, wireApi: string): string =>
      transport === 'openai' && wireApi === 'responses' ? 'chatgpt' : transport;

    const cases: Parameters<typeof resolveProfile>[1][] = [
      { model: 'gpt-4o' },
      { apiMode: 'responses', model: 'gpt-4o' },
      { authType: 'subscription', model: 'gpt-4o' },
    ];
    for (const opts of cases) {
      const r = resolveProfile('openai', opts)!;
      expect(toLegacyFormat(r.transport, r.wireApi)).toBe(PROVIDER_ENDPOINTS[r.endpointKey].format);
    }
  });
});
