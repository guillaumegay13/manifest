/**
 * Transitional bridge between the declarative profile model and the legacy
 * registry. `buildRequest` dispatches on a `WireSpec` (vendor + wire shape)
 * rather than the overloaded `ProviderEndpoint.format`. Migrated providers
 * supply their `WireSpec` from a profile; unmigrated providers derive it from
 * the registry's `format` here. When every provider has a profile, this file
 * and `format` both disappear.
 */
import { ProviderEndpoint } from './provider-endpoints';
import { ResolvedProfile } from './provider-profiles';

export type WireSpec = Pick<ResolvedProfile, 'transport' | 'wireApi' | 'quirks'>;

/**
 * Decompose the legacy overloaded `format` into the (vendor, wire-shape) pair.
 * `'chatgpt'` is the OpenAI vendor speaking the Responses API. `kiro` never
 * reaches `buildRequest` (handled earlier in `forward`), so its mapping is
 * inert — present only to keep this map total over `format`.
 */
const FORMAT_TO_WIRE: Record<ProviderEndpoint['format'], Omit<WireSpec, 'quirks'>> = {
  openai: { transport: 'openai', wireApi: 'chat_completions' },
  chatgpt: { transport: 'openai', wireApi: 'responses' },
  anthropic: { transport: 'anthropic', wireApi: 'chat_completions' },
  google: { transport: 'google', wireApi: 'chat_completions' },
  kiro: { transport: 'openai', wireApi: 'chat_completions' },
};

export function deriveWireSpec(
  profile: ResolvedProfile | null,
  legacyFormat: ProviderEndpoint['format'],
): WireSpec {
  if (profile) {
    return { transport: profile.transport, wireApi: profile.wireApi, quirks: profile.quirks };
  }
  const mapped = FORMAT_TO_WIRE[legacyFormat];
  return { transport: mapped.transport, wireApi: mapped.wireApi };
}
