import { isFreeTierModel, normalizeProviderId, FREE_TIER_PROVIDER_IDS } from './free-tier-models';

describe('free-tier-models', () => {
  it('normalizes provider aliases to canonical ids', () => {
    expect(normalizeProviderId('GitHub Models')).toBe('github-models');
    expect(normalizeProviderId('LLM7.io')).toBe('llm7');
  });

  it('marks documented free-tier provider catalogs as free', () => {
    expect(
      isFreeTierModel({
        provider: 'groq',
        id: 'llama-3.1-8b-instant',
        inputPricePerToken: null,
        outputPricePerToken: null,
      }),
    ).toBe(true);
  });

  it('marks openrouter free models as free even without zero pricing', () => {
    expect(
      isFreeTierModel({
        provider: 'openrouter',
        id: 'deepseek/deepseek-r1:free',
        inputPricePerToken: null,
        outputPricePerToken: null,
      }),
    ).toBe(true);
  });

  it('marks explicit zero-price models as free for non-subscription auth', () => {
    expect(
      isFreeTierModel({
        provider: 'custom:cp-1',
        id: 'custom:cp-1/my-model',
        inputPricePerToken: 0,
        outputPricePerToken: 0,
      }),
    ).toBe(true);
  });

  it('does not mark subscription models as free just because their routed price is zero', () => {
    expect(
      isFreeTierModel({
        provider: 'openai',
        id: 'gpt-5',
        inputPricePerToken: 0,
        outputPricePerToken: 0,
        authType: 'subscription',
      }),
    ).toBe(false);
  });

  it('keeps a stable set of documented free-tier providers', () => {
    expect(Array.from(FREE_TIER_PROVIDER_IDS).sort()).toEqual([
      'cerebras',
      'cloudflare',
      'cohere',
      'github-models',
      'groq',
      'huggingface',
      'llm7',
      'ollama',
      'ollama-cloud',
    ]);
  });
});
