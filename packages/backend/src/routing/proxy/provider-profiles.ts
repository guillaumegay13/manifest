/**
 * Declarative provider profiles — the single source of truth for how a provider
 * behaves on the wire. One object per provider co-locates everything that today
 * is scattered across `resolveEndpoint()`'s if-chain, `provider-hooks.ts`, and
 * the module-level `Set`s in `provider-client-converters.ts`.
 *
 * Migration is incremental: a provider with a profile here is resolved by the
 * generic `resolveProfile()` engine; a provider without one returns `null` and
 * falls back to the legacy resolution path in `provider-client.ts`. When every
 * provider has a profile, the legacy chain is deleted.
 *
 * This file currently carries OpenAI only (the variant-heaviest provider) to
 * validate the shape against real behaviour.
 */
import { OPENAI_RESPONSES_ONLY_RE, stripVendorPrefix } from '../../common/constants/openai-models';
import { ForwardOptions } from './proxy-types';

/** Wire family. Mirrors `ProviderEndpoint.format` so resolution stays in parity. */
type Transport = 'openai' | 'anthropic' | 'google' | 'chatgpt';

/**
 * Per-provider request quirks that today live as global `Set`s consulted by the
 * engine. Declared here as data; consumption is migrated in a later increment.
 */
export interface ProviderQuirks {
  /** Models that require `max_completion_tokens` instead of `max_tokens`. */
  maxCompletionTokensModels?: RegExp;
  /** Whether streaming requests opt into `stream_options.include_usage`. */
  streamUsageOptions?: boolean;
}

/** The wire-shape fields a variant may override on top of its base profile. */
interface WireShape {
  endpointKey: string;
  transport: Transport;
  baseUrl: string;
  path: string;
}

type ProviderVariant = Partial<WireShape>;

export interface ProviderProfile extends WireShape {
  id: string;
  quirks?: ProviderQuirks;
  /** Named overlays selected by auth type / api mode (e.g. subscription, responses). */
  variants?: Record<string, ProviderVariant>;
  /** Model-name → variant rules, replacing per-provider regex if-branches. */
  modelRouting?: { match: RegExp; variant: string }[];
}

export interface ResolvedProfile {
  endpointKey: string;
  transport: Transport;
  baseUrl: string;
  path: string;
  quirks?: ProviderQuirks;
}

interface ResolveOptions {
  authType?: string;
  apiMode?: ForwardOptions['apiMode'];
  model: string;
}

export const PROVIDER_PROFILES: Record<string, ProviderProfile> = {
  openai: {
    id: 'openai',
    endpointKey: 'openai',
    transport: 'openai',
    baseUrl: 'https://api.openai.com',
    path: '/v1/chat/completions',
    quirks: {
      maxCompletionTokensModels: /^(o\d|gpt-5)/i,
      streamUsageOptions: true,
    },
    modelRouting: [{ match: OPENAI_RESPONSES_ONLY_RE, variant: 'responses' }],
    variants: {
      // ChatGPT subscription OAuth → Codex backend (separate base + path).
      subscription: {
        endpointKey: 'openai-subscription',
        transport: 'chatgpt',
        baseUrl: 'https://chatgpt.com/backend-api',
        path: '/codex/responses',
      },
      // API-key Responses API: explicit `apiMode: 'responses'` and the
      // responses-only model families (Codex, *-pro, o1-pro, deep-research).
      responses: {
        endpointKey: 'openai-responses',
        transport: 'chatgpt',
        path: '/v1/responses',
      },
    },
  },
};

/**
 * Select the variant overlay for a request. Precedence mirrors the legacy
 * `resolveEndpoint()` exactly: subscription wins, then explicit responses mode,
 * then responses-only model routing.
 */
function selectVariant(base: ProviderProfile, opts: ResolveOptions): ProviderVariant | undefined {
  if (opts.authType === 'subscription' && base.variants?.subscription) {
    return base.variants.subscription;
  }
  if (opts.apiMode === 'responses' && base.variants?.responses) {
    return base.variants.responses;
  }
  const bareModel = stripVendorPrefix(opts.model);
  for (const rule of base.modelRouting ?? []) {
    if (rule.match.test(bareModel)) return base.variants?.[rule.variant];
  }
  return undefined;
}

/**
 * Resolve a provider + request context to its concrete wire shape. Returns
 * `null` for providers not yet migrated to a profile, so callers can fall back
 * to the legacy resolution path.
 */
export function resolveProfile(provider: string, opts: ResolveOptions): ResolvedProfile | null {
  const base = PROVIDER_PROFILES[provider.toLowerCase()];
  if (!base) return null;

  const variant = selectVariant(base, opts);
  return {
    endpointKey: variant?.endpointKey ?? base.endpointKey,
    transport: variant?.transport ?? base.transport,
    baseUrl: variant?.baseUrl ?? base.baseUrl,
    path: variant?.path ?? base.path,
    quirks: base.quirks,
  };
}
