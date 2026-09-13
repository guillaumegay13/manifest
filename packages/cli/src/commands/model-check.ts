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

  const missing = models.filter((m) => {
    if (!enforceProvider || providerId === null) return !names.has(m);
    const qualified = m.startsWith(`${providerId}/`) ? m.slice(providerId.length + 1) : m;
    return !rows.some((r) => r.model === qualified && r.provider === providerId);
  });
  if (missing.length === 0) return;
  throw new CliError(
    'unknown_model',
    `Not in the models discovered for "${agent}"${
      enforceProvider ? ` under ${providerId}` : ''
    }: ${missing.join(', ')}`,
    `The catalog may be stale or empty — rediscover with mnfst provider refresh (and check mnfst models ${agent}); or pass --force to write the route anyway (the backend supports provider-qualified passthrough for uncatalogued models)`,
  );
}
