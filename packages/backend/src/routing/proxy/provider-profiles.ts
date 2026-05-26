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
import { OLLAMA_CLOUD_HOST, OLLAMA_HOST } from '../../common/constants/ollama';
import { OPENAI_RESPONSES_ONLY_RE, stripVendorPrefix } from '../../common/constants/openai-models';
import {
  CODEX_CLI_ORIGINATOR,
  CODEX_CLI_USER_AGENT,
  COPILOT_EDITOR_VERSION,
  COPILOT_PLUGIN_VERSION,
} from '../../common/constants/subscription-clients';
import { XAI_RESPONSES_ONLY_RE } from '../../common/constants/xai-models';
import { getQwenCompatibleBaseUrl } from '../qwen-region';
import { ForwardOptions } from './proxy-types';

/**
 * Vendor family — *who* we're talking to. Orthogonal to the wire shape.
 * The legacy `ProviderEndpoint.format` conflated this with `wireApi`: an
 * OpenAI-vendor endpoint speaking the Responses API was tagged `'chatgpt'`.
 */
type Transport = 'openai' | 'anthropic' | 'google';

/** Wire shape — *which* request/response schema. Today only OpenAI has two. */
type WireApi = 'chat_completions' | 'responses';

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

/**
 * How to authenticate to the upstream. Replaces the per-endpoint `buildHeaders`
 * closures in the registry with declarative data.
 */
export interface AuthRecipe {
  scheme: 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'none';
  /** Static extra headers (e.g. anthropic-version, Codex/Copilot client tags). */
  headers?: Record<string, string>;
}

/** The wire-shape fields a variant may override on top of its base profile. */
interface WireShape {
  endpointKey: string;
  transport: Transport;
  wireApi: WireApi;
  auth: AuthRecipe;
  baseUrl: string;
  path: string;
}

type ProviderVariant = Partial<WireShape>;

export interface ProviderProfile extends WireShape {
  id: string;
  quirks?: ProviderQuirks;
  /** Named overlays selected by auth type / api mode (e.g. subscription, responses). */
  variants?: Record<string, ProviderVariant>;
  /**
   * Variant to select when the *inbound* request is the Responses API
   * (`apiMode='responses'`). Opt-in: legacy only does this for openai + xai,
   * NOT copilot (which routes to /responses purely by model family).
   */
  apiModeResponsesVariant?: string;
  /** Model-name → variant rules, replacing per-provider regex if-branches. */
  modelRouting?: { match: RegExp; variant: string }[];
}

export interface ResolvedProfile {
  endpointKey: string;
  transport: Transport;
  wireApi: WireApi;
  auth: AuthRecipe;
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
    wireApi: 'chat_completions',
    auth: { scheme: 'bearer' },
    baseUrl: 'https://api.openai.com',
    path: '/v1/chat/completions',
    quirks: {
      maxCompletionTokensModels: /^(o\d|gpt-5)/i,
      streamUsageOptions: true,
    },
    apiModeResponsesVariant: 'responses',
    modelRouting: [{ match: OPENAI_RESPONSES_ONLY_RE, variant: 'responses' }],
    variants: {
      // ChatGPT subscription OAuth → Codex backend (separate base + path),
      // still the OpenAI vendor speaking the Responses API.
      subscription: {
        endpointKey: 'openai-subscription',
        wireApi: 'responses',
        auth: {
          scheme: 'bearer',
          headers: { originator: CODEX_CLI_ORIGINATOR, 'user-agent': CODEX_CLI_USER_AGENT },
        },
        baseUrl: 'https://chatgpt.com/backend-api',
        path: '/codex/responses',
      },
      // API-key Responses API: explicit `apiMode: 'responses'` and the
      // responses-only model families (Codex, *-pro, o1-pro, deep-research).
      responses: {
        endpointKey: 'openai-responses',
        wireApi: 'responses',
        path: '/v1/responses',
      },
    },
  },

  // ── Plain OpenAI-compatible providers (bearer auth, /v1/chat/completions) ──
  deepseek: {
    id: 'deepseek',
    endpointKey: 'deepseek',
    transport: 'openai',
    wireApi: 'chat_completions',
    auth: { scheme: 'bearer' },
    baseUrl: 'https://api.deepseek.com',
    path: '/v1/chat/completions',
    quirks: { streamUsageOptions: true },
  },
  groq: {
    id: 'groq',
    endpointKey: 'groq',
    transport: 'openai',
    wireApi: 'chat_completions',
    auth: { scheme: 'bearer' },
    baseUrl: 'https://api.groq.com/openai',
    path: '/v1/chat/completions',
    quirks: { streamUsageOptions: true },
  },
  mistral: {
    id: 'mistral',
    endpointKey: 'mistral',
    transport: 'openai',
    wireApi: 'chat_completions',
    auth: { scheme: 'bearer' },
    baseUrl: 'https://api.mistral.ai',
    path: '/v1/chat/completions',
    quirks: { streamUsageOptions: true },
  },
  moonshot: {
    id: 'moonshot',
    endpointKey: 'moonshot',
    transport: 'openai',
    wireApi: 'chat_completions',
    auth: { scheme: 'bearer' },
    baseUrl: 'https://api.moonshot.ai',
    path: '/v1/chat/completions',
    quirks: { streamUsageOptions: true },
  },
  // Kilo is the lone OpenAI-compatible provider NOT in SUPPORTS_USAGE_STREAM_OPTIONS.
  kilo: {
    id: 'kilo',
    endpointKey: 'kilo',
    transport: 'openai',
    wireApi: 'chat_completions',
    auth: { scheme: 'bearer' },
    baseUrl: 'https://api.kilo.ai/api/gateway',
    path: '/chat/completions',
    quirks: { streamUsageOptions: false },
  },
  openrouter: {
    id: 'openrouter',
    endpointKey: 'openrouter',
    transport: 'openai',
    wireApi: 'chat_completions',
    auth: {
      scheme: 'bearer',
      headers: { 'HTTP-Referer': 'https://manifest.build', 'X-Title': 'Manifest' },
    },
    baseUrl: 'https://openrouter.ai',
    path: '/api/v1/chat/completions',
    quirks: { streamUsageOptions: true },
  },
  // Ollama (local) takes no auth header.
  ollama: {
    id: 'ollama',
    endpointKey: 'ollama',
    transport: 'openai',
    wireApi: 'chat_completions',
    auth: { scheme: 'none' },
    baseUrl: OLLAMA_HOST,
    path: '/v1/chat/completions',
    quirks: { streamUsageOptions: true },
  },
  'ollama-cloud': {
    id: 'ollama-cloud',
    endpointKey: 'ollama-cloud',
    transport: 'openai',
    wireApi: 'chat_completions',
    auth: { scheme: 'bearer' },
    baseUrl: OLLAMA_CLOUD_HOST,
    path: '/v1/chat/completions',
    quirks: { streamUsageOptions: true },
  },
  // Qwen's region override is applied upstream via a customEndpoint (which
  // bypasses profiles); the by-name path uses the default Beijing base.
  qwen: {
    id: 'qwen',
    endpointKey: 'qwen',
    transport: 'openai',
    wireApi: 'chat_completions',
    auth: { scheme: 'bearer' },
    baseUrl: getQwenCompatibleBaseUrl('beijing'),
    path: '/v1/chat/completions',
    quirks: { streamUsageOptions: true },
  },

  // ── OpenAI-compatible base + Responses-API variant ──
  // xAI: multi-agent Grok models are /v1/responses-only; the /v1/responses
  // inbound mode also routes here.
  xai: {
    id: 'xai',
    endpointKey: 'xai',
    transport: 'openai',
    wireApi: 'chat_completions',
    auth: { scheme: 'bearer' },
    baseUrl: 'https://api.x.ai',
    path: '/v1/chat/completions',
    quirks: { streamUsageOptions: true },
    apiModeResponsesVariant: 'responses',
    modelRouting: [{ match: XAI_RESPONSES_ONLY_RE, variant: 'responses' }],
    variants: {
      responses: { endpointKey: 'xai-responses', wireApi: 'responses', path: '/v1/responses' },
    },
  },
  // GitHub Copilot: Codex variants are served only at /responses (by model
  // family). Note: copilot does NOT route on apiMode='responses' (no
  // apiModeResponsesVariant) — matches legacy.
  copilot: {
    id: 'copilot',
    endpointKey: 'copilot',
    transport: 'openai',
    wireApi: 'chat_completions',
    auth: {
      scheme: 'bearer',
      headers: {
        'Editor-Version': COPILOT_EDITOR_VERSION,
        'Editor-Plugin-Version': COPILOT_PLUGIN_VERSION,
        'Copilot-Integration-Id': 'vscode-chat',
      },
    },
    baseUrl: 'https://api.githubcopilot.com',
    path: '/chat/completions',
    quirks: { streamUsageOptions: true },
    modelRouting: [{ match: OPENAI_RESPONSES_ONLY_RE, variant: 'responses' }],
    variants: {
      responses: { endpointKey: 'copilot-responses', wireApi: 'responses', path: '/responses' },
    },
  },
  // Z.ai: subscription auth swaps to the Coding-Plan backend (still OpenAI-shaped).
  zai: {
    id: 'zai',
    endpointKey: 'zai',
    transport: 'openai',
    wireApi: 'chat_completions',
    auth: { scheme: 'bearer' },
    baseUrl: 'https://api.z.ai',
    path: '/api/paas/v4/chat/completions',
    quirks: { streamUsageOptions: true },
    variants: {
      subscription: {
        endpointKey: 'zai-subscription',
        baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
        path: '/chat/completions',
      },
    },
  },
  // OpenCode Go: MiniMax models speak the native Anthropic protocol (x-api-key,
  // /v1/messages); everything else is OpenAI-shaped. Same base URL either way.
  'opencode-go': {
    id: 'opencode-go',
    endpointKey: 'opencode-go',
    transport: 'openai',
    wireApi: 'chat_completions',
    auth: { scheme: 'bearer' },
    baseUrl: 'https://opencode.ai/zen/go',
    path: '/v1/chat/completions',
    quirks: { streamUsageOptions: true },
    modelRouting: [{ match: /^minimax-/i, variant: 'anthropic' }],
    variants: {
      anthropic: {
        endpointKey: 'opencode-go-anthropic',
        transport: 'anthropic',
        auth: { scheme: 'x-api-key', headers: { 'anthropic-version': '2023-06-01' } },
        path: '/v1/messages',
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
  if (opts.apiMode === 'responses' && base.apiModeResponsesVariant) {
    return base.variants?.[base.apiModeResponsesVariant];
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
    wireApi: variant?.wireApi ?? base.wireApi,
    auth: variant?.auth ?? base.auth,
    baseUrl: variant?.baseUrl ?? base.baseUrl,
    path: variant?.path ?? base.path,
    quirks: base.quirks,
  };
}

/** Build request headers from a declarative auth recipe. */
export function buildProfileHeaders(auth: AuthRecipe, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...auth.headers,
  };
  if (auth.scheme === 'bearer') {
    headers['Authorization'] = `Bearer ${apiKey}`;
  } else if (auth.scheme === 'x-api-key') {
    headers['x-api-key'] = apiKey;
  } else if (auth.scheme === 'x-goog-api-key') {
    headers['x-goog-api-key'] = apiKey;
  }
  return headers;
}
