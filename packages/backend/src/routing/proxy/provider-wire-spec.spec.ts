import { deriveWireSpec } from './provider-wire-spec';
import { resolveProfile } from './provider-profiles';

describe('deriveWireSpec', () => {
  it('uses the resolved profile when one exists (OpenAI)', () => {
    const responses = deriveWireSpec(
      resolveProfile('openai', { apiMode: 'responses', model: 'gpt-4o' }),
      'openai',
    );
    expect(responses.transport).toBe('openai');
    expect(responses.wireApi).toBe('responses');
    expect(responses.quirks?.streamUsageOptions).toBe(true);
  });

  it('derives transport/wireApi from the legacy registry format when unmigrated', () => {
    expect(deriveWireSpec(null, 'openai')).toMatchObject({
      transport: 'openai',
      wireApi: 'chat_completions',
    });
    expect(deriveWireSpec(null, 'chatgpt')).toMatchObject({
      transport: 'openai',
      wireApi: 'responses',
    });
    expect(deriveWireSpec(null, 'anthropic')).toMatchObject({ transport: 'anthropic' });
    expect(deriveWireSpec(null, 'google')).toMatchObject({ transport: 'google' });
  });

  it('maps the kiro format safely (kiro is handled before buildRequest)', () => {
    expect(deriveWireSpec(null, 'kiro').transport).toBe('openai');
  });

  it('carries no quirks for unmigrated providers — the legacy Sets still own those', () => {
    expect(deriveWireSpec(null, 'openai').quirks).toBeUndefined();
  });
});
