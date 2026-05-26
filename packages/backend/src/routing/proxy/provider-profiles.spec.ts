import { buildProfileHeaders, PROVIDER_PROFILES, resolveProfile } from './provider-profiles';
import { PROVIDER_ENDPOINTS } from './provider-endpoints';
import {
  CODEX_CLI_ORIGINATOR,
  CODEX_CLI_USER_AGENT,
} from '../../common/constants/subscription-clients';

describe('resolveProfile — OpenAI profile (migration spike)', () => {
  it('returns null for providers not yet migrated to a profile', () => {
    expect(resolveProfile('anthropic', { model: 'claude-sonnet-4' })).toBeNull();
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

describe('buildProfileHeaders', () => {
  it('builds bearer auth + JSON content type', () => {
    expect(buildProfileHeaders({ scheme: 'bearer' }, 'sk-123')).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-123',
    });
  });

  it('builds x-api-key auth', () => {
    expect(buildProfileHeaders({ scheme: 'x-api-key' }, 'sk-123')).toEqual({
      'Content-Type': 'application/json',
      'x-api-key': 'sk-123',
    });
  });

  it('builds x-goog-api-key auth', () => {
    expect(buildProfileHeaders({ scheme: 'x-goog-api-key' }, 'sk-123')).toEqual({
      'Content-Type': 'application/json',
      'x-goog-api-key': 'sk-123',
    });
  });

  it('omits the auth header for scheme "none"', () => {
    expect(buildProfileHeaders({ scheme: 'none' }, 'sk-123')).toEqual({
      'Content-Type': 'application/json',
    });
  });

  it('merges static extra headers', () => {
    expect(
      buildProfileHeaders({ scheme: 'bearer', headers: { 'X-Title': 'Manifest' } }, 'sk-123'),
    ).toEqual({
      'Content-Type': 'application/json',
      'X-Title': 'Manifest',
      Authorization: 'Bearer sk-123',
    });
  });
});

describe('OpenAI auth recipes match the legacy registry header closures (parity)', () => {
  it('base profile → registry openai headers', () => {
    const r = resolveProfile('openai', { model: 'gpt-4o' })!;
    expect(buildProfileHeaders(r.auth, 'sk-x')).toEqual(
      PROVIDER_ENDPOINTS[r.endpointKey].buildHeaders('sk-x'),
    );
  });

  it('responses variant → registry openai-responses headers', () => {
    const r = resolveProfile('openai', { apiMode: 'responses', model: 'gpt-4o' })!;
    expect(buildProfileHeaders(r.auth, 'sk-x')).toEqual(
      PROVIDER_ENDPOINTS[r.endpointKey].buildHeaders('sk-x'),
    );
  });

  it('subscription variant → registry openai-subscription Codex headers', () => {
    const r = resolveProfile('openai', { authType: 'subscription', model: 'gpt-4o' })!;
    const built = buildProfileHeaders(r.auth, 'sk-x');
    expect(built).toEqual(PROVIDER_ENDPOINTS[r.endpointKey].buildHeaders('sk-x'));
    expect(built.originator).toBe(CODEX_CLI_ORIGINATOR);
    expect(built['user-agent']).toBe(CODEX_CLI_USER_AGENT);
  });
});

/**
 * Auto-parity: every migrated profile's *base* resolution must reproduce its
 * legacy registry entry exactly (URL, headers, format). This fails the moment a
 * new profile drifts from the registry it replaces. Variant-specific parity is
 * covered by the targeted tests above.
 */
describe('every profile base ⇄ legacy registry (auto-parity)', () => {
  const toLegacyFormat = (transport: string, wireApi: string): string =>
    transport === 'openai' && wireApi === 'responses' ? 'chatgpt' : transport;

  for (const id of Object.keys(PROVIDER_PROFILES)) {
    it(`${id} base matches PROVIDER_ENDPOINTS`, () => {
      const r = resolveProfile(id, { model: 'parity-probe' })!;
      const ep = PROVIDER_ENDPOINTS[r.endpointKey];
      expect(`${r.baseUrl}${r.path}`).toBe(`${ep.baseUrl}${ep.buildPath('parity-probe')}`);
      expect(buildProfileHeaders(r.auth, 'KEY')).toEqual(ep.buildHeaders('KEY'));
      expect(toLegacyFormat(r.transport, r.wireApi)).toBe(ep.format);
    });
  }
});

describe('streamUsageOptions quirk matches legacy SUPPORTS_USAGE_STREAM_OPTIONS', () => {
  // Explicit expectations pin the Set membership the profile replaces.
  const expected: Record<string, boolean> = {
    openai: true,
    deepseek: true,
    groq: true,
    mistral: true,
    moonshot: true,
    kilo: false,
  };
  for (const [id, want] of Object.entries(expected)) {
    it(`${id} → ${want}`, () => {
      expect(PROVIDER_PROFILES[id].quirks?.streamUsageOptions).toBe(want);
    });
  }
});
