import { PROVIDER_BY_ID_OR_ALIAS } from '../../common/constants/providers';

type FreeTierCandidate = {
  provider: string;
  id: string;
  inputPricePerToken: number | null;
  outputPricePerToken: number | null;
  authType?: 'api_key' | 'subscription';
};

type FreeTierRule = { mode: 'all' } | { mode: 'pattern'; patterns: readonly RegExp[] };

const PROVIDERS_WITH_FREE_TIER_CATALOG = [
  'cerebras',
  'cloudflare',
  'cohere',
  'github-models',
  'groq',
  'huggingface',
  'llm7',
  'ollama',
  'ollama-cloud',
] as const;

const FREE_TIER_RULES: Readonly<Record<string, FreeTierRule>> = {
  cerebras: { mode: 'all' },
  cloudflare: { mode: 'all' },
  cohere: { mode: 'all' },
  'github-models': { mode: 'all' },
  groq: { mode: 'all' },
  huggingface: { mode: 'all' },
  llm7: { mode: 'all' },
  ollama: { mode: 'all' },
  'ollama-cloud': { mode: 'all' },
  openrouter: {
    mode: 'pattern',
    patterns: [/^openrouter\/free$/i, /:free$/i],
  },
};

export function normalizeProviderId(provider: string): string {
  const lower = provider.toLowerCase();
  if (lower.startsWith('custom:')) return lower;
  return PROVIDER_BY_ID_OR_ALIAS.get(lower)?.id ?? lower;
}

export function isFreeTierModel(candidate: FreeTierCandidate): boolean {
  if (candidate.authType === 'subscription') return false;

  if (
    candidate.inputPricePerToken != null &&
    candidate.outputPricePerToken != null &&
    Number(candidate.inputPricePerToken) === 0 &&
    Number(candidate.outputPricePerToken) === 0
  ) {
    return true;
  }

  const providerId = normalizeProviderId(candidate.provider);
  const rule = FREE_TIER_RULES[providerId];
  if (!rule) return false;

  if (rule.mode === 'all') return true;
  return rule.patterns.some((pattern) => pattern.test(candidate.id));
}

export const FREE_TIER_PROVIDER_IDS = new Set<string>(PROVIDERS_WITH_FREE_TIER_CATALOG);
