import { ApiClient } from '../client';
import { CliError } from '../errors';
import { resolveProviderId } from './provider';

interface DiscoveredModel {
  model: string;
  provider?: string;
}

/** The agent's discovered models (union of its ENABLED connections), with the
 * connection each came from so a route can be checked against its provider. */
async function discoveredModels(client: ApiClient, agent: string): Promise<DiscoveredModel[]> {
  const rows = (await client.request(
    'GET',
    `/routing/${encodeURIComponent(agent)}/available-models`,
  )) as unknown;
  return (Array.isArray(rows) ? rows : [])
    .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
    .map((m) => ({
      model: typeof m['model_name'] === 'string' ? (m['model_name'] as string) : '',
      ...(typeof m['provider'] === 'string' ? { provider: m['provider'] as string } : {}),
    }))
    .filter((m) => m.model !== '');
}

/**
 * One gate for every command that writes a route: a model the agent cannot
 * see is a typo or a hollow connection, and catching it here beats finding
 * out on live traffic. Shared by `agent configure` and `routing custom
 * create` so the two can never drift.
 *
 * When `provider` is given and the backend reports which connection each
 * model came from, the model must be discovered under THAT provider — a model
 * another enabled provider happens to expose is not routable through this one.
 * The provider is resolved through the catalog (aliases included);
 * provider-qualified ids (`openai/gpt-4o`) are matched on their provider part.
 * Unresolvable inputs (custom providers) fall back to the name-only check.
 *
 * `force` skips the check — the backend still routes an uncatalogued model
 * through provider-qualified passthrough, so the CLI must not be the thing
 * that makes a brand-new model unusable.
 */
export async function assertModelsDiscovered(
  client: ApiClient,
  agent: string,
  models: readonly string[],
  force: boolean,
  provider?: string,
): Promise<void> {
  if (force || models.length === 0) return;
  const rows = await discoveredModels(client, agent);

  let providerId: string | null = null;
  if (provider !== undefined) {
    try {
      providerId = resolveProviderId(provider);
    } catch {
      providerId = null; // custom provider or unknown input — name-only check
    }
  }
  const rowsCarryProvider = rows.some((r) => r.provider !== undefined);
  const names = new Set(rows.map((r) => r.model));
  const enforceProvider = providerId !== null && rowsCarryProvider;
  const providersFor = (model: string): Set<string> =>
    new Set(
      rows
        .filter((r) => r.model === model && r.provider !== undefined)
        .map((r) => r.provider as string),
    );

  const missing: string[] = [];
  const ambiguous: string[] = [];
  models.forEach((m, index) => {
    // Only the route (first) model is pinned to this provider. Fallbacks are
    // stored provider-agnostic and resolved at runtime, so they can belong to
    // another provider and are checked by name only.
    if (enforceProvider && providerId !== null && index === 0) {
      const pid = providerId;
      const qualified = m.startsWith(`${pid}/`) ? m.slice(pid.length + 1) : m;
      if (!rows.some((r) => r.provider === pid && (r.model === m || r.model === qualified))) {
        missing.push(m);
      }
      return;
    }
    if (!names.has(m)) {
      missing.push(m);
      return;
    }
    // A bare fallback exposed by more than one provider cannot be resolved
    // unambiguously at write time. Reject before the route is written, so a
    // partial configure never leaves the primary route applied.
    const providers = providersFor(m);
    const qualified = [...providers].some((p) => m.startsWith(`${p}/`));
    if (providers.size > 1 && !qualified) ambiguous.push(m);
  });

  if (ambiguous.length > 0) {
    throw new CliError(
      'ambiguous_model',
      `Ambiguous fallback for "${agent}" (several providers expose it): ${ambiguous.join(', ')}`,
      'Qualify the fallback with its provider (provider/model), or pass --force',
    );
  }
  if (missing.length === 0) return;
  throw new CliError(
    'unknown_model',
    `Not in the models discovered for "${agent}"${
      enforceProvider ? ` under ${providerId}` : ''
    }: ${missing.join(', ')}`,
    `The catalog may be stale or empty — rediscover with mnfst provider refresh (and check mnfst models ${agent}); or pass --force to write the route anyway (the backend supports provider-qualified passthrough for uncatalogued models)`,
  );
}
