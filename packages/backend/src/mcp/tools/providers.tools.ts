import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { SHARED_PROVIDERS, SUPPORTED_SUBSCRIPTION_PROVIDER_IDS } from 'manifest-shared';
import { AgentEnabledProvider } from '../../entities/agent-enabled-provider.entity';
import { McpOperator, MCP_WRITE_SCOPE } from '../mcp-auth';
import { McpToolDeps } from '../tool-deps';
import { err, ok } from '../tool-result';

function result(promise: Promise<unknown>) {
  return promise.then(ok).catch((e: unknown) => err(e instanceof Error ? e.message : String(e)));
}

const AUTH_TYPES = ['api_key', 'subscription', 'local'] as const;

/**
 * Provider connection tools. Providers are tenant-global; an agent only decides
 * which connection performs a discovery call. The catalog comes from
 * manifest-shared — the same registry the CLI and dashboard use — so "what can
 * I connect?" cannot drift between surfaces.
 */
export function registerProviderTools(
  server: McpServer,
  deps: McpToolDeps,
  operator: McpOperator,
): void {
  server.registerTool(
    'manifest_provider_list',
    {
      title: 'List provider connections',
      description: 'List the workspace provider connections and their cached model counts.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      result(
        (async () => ({
          connections: (await deps.providers.getProviders(operator.tenantId)).map((p) => ({
            id: p.id,
            provider: p.provider,
            auth_type: p.auth_type,
            label: p.label,
            region: p.region,
            is_active: p.is_active,
            key_prefix: p.key_prefix,
            cached_model_count: p.cached_models?.length ?? 0,
            models_fetched_at: p.models_fetched_at,
            connected_at: p.connected_at,
          })),
          custom_providers: (await deps.customProviders.list(operator.tenantId)).map((c) => ({
            id: c.id,
            name: c.name,
            alias: c.alias,
            base_url: c.base_url,
          })),
        }))(),
      ),
  );

  server.registerTool(
    'manifest_provider_catalog',
    {
      title: 'Provider catalog',
      description: 'List every connectable provider with its supported auth types.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      ok({
        providers: SHARED_PROVIDERS.map((p) => ({
          id: p.id,
          displayName: p.displayName,
          ...(p.aliases.length ? { aliases: [...p.aliases] } : {}),
          authTypes: [
            ...(p.localOnly ? ['local'] : []),
            ...(p.requiresApiKey ? ['api_key'] : []),
            ...(SUPPORTED_SUBSCRIPTION_PROVIDER_IDS.includes(p.id) ? ['subscription'] : []),
          ],
        })),
      }),
  );

  server.registerTool(
    'manifest_provider_custom_list',
    {
      title: 'List custom providers',
      description:
        'List the workspace custom providers (OpenAI- or Anthropic-compatible endpoints).',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      result(
        (async () => ({
          custom_providers: (await deps.customProviders.list(operator.tenantId)).map((c) => ({
            id: c.id,
            name: c.name,
            alias: c.alias,
            base_url: c.base_url,
          })),
        }))(),
      ),
  );

  // Everything below connects, disconnects, or mutates provider access — a
  // read-only token must not see these tools.
  if (!operator.scopes.has(MCP_WRITE_SCOPE)) return;

  server.registerTool(
    'manifest_provider_connect',
    {
      title: 'Connect a provider',
      description:
        'Connect a provider for the workspace (tenant-wide) and discover its models. Supply the credential via api_key.',
      inputSchema: z.object({
        provider: z.string().min(1),
        api_key: z.string().min(1).optional(),
        auth_type: z.enum(AUTH_TYPES).optional(),
        region: z.string().min(1).optional(),
        label: z.string().max(50).optional(),
        agent: z.string().min(1).describe('Agent that performs discovery.'),
      }),
    },
    async ({ provider, api_key, auth_type, region, label, agent }) =>
      result(
        (async () => {
          const resolved = await deps.resolveAgent.resolve(operator.tenantId, agent, {
            allowPlayground: true,
          });
          const upserted = await deps.providers.upsertProvider(
            resolved.id,
            resolved.tenant_id,
            provider,
            api_key,
            auth_type,
            region,
            label,
            operator.userId,
          );
          await deps.modelDiscovery.discoverModels(upserted.provider);
          return {
            id: upserted.provider.id,
            provider: upserted.provider.provider,
            auth_type: upserted.provider.auth_type,
            is_new: upserted.isNew,
            label: upserted.provider.label,
          };
        })(),
      ),
  );

  server.registerTool(
    'manifest_provider_disconnect',
    {
      title: 'Disconnect a provider',
      description: 'Remove a provider connection from the workspace.',
      inputSchema: z.object({
        provider: z.string().min(1),
        auth_type: z.enum(AUTH_TYPES).optional(),
        label: z.string().min(1).optional(),
        agent: z.string().min(1),
      }),
    },
    async ({ provider, auth_type, label, agent }) =>
      result(
        (async () => {
          const resolved = await deps.resolveAgent.resolve(operator.tenantId, agent, {});
          const { notifications } = await deps.providers.removeProvider(
            resolved.id,
            resolved.tenant_id,
            provider,
            auth_type,
            label,
          );
          return { ok: true, notifications };
        })(),
      ),
  );

  server.registerTool(
    'manifest_provider_refresh',
    {
      title: 'Refresh provider models',
      description:
        'Re-run model discovery. With a provider, refresh that connection; otherwise refresh every connection for the agent.',
      inputSchema: z.object({
        agent: z.string().min(1),
        provider: z.string().min(1).optional(),
        auth_type: z.enum(AUTH_TYPES).optional(),
      }),
    },
    async ({ agent, provider, auth_type }) =>
      result(
        (async () => {
          const resolved = await deps.resolveAgent.resolve(operator.tenantId, agent, {
            allowPlayground: true,
          });
          if (provider) {
            const refreshed = await deps.modelDiscovery.refreshProvider(
              resolved.tenant_id,
              provider,
              auth_type,
            );
            return { provider, ...refreshed };
          }
          await deps.modelDiscovery.discoverAllForAgent(resolved.tenant_id, { forceRefresh: true });
          const connections = await deps.providers.getProviders(resolved.tenant_id);
          return {
            connections: connections.map((p) => ({
              provider: p.provider,
              auth_type: p.auth_type,
              label: p.label,
              cached_model_count: p.cached_models?.length ?? 0,
            })),
          };
        })(),
      ),
  );

  server.registerTool(
    'manifest_provider_custom_add',
    {
      title: 'Register a custom provider',
      description:
        'Register a custom OpenAI- or Anthropic-compatible provider. Models are discovered from the endpoint when not supplied.',
      inputSchema: z.object({
        name: z.string().min(1).max(50),
        base_url: z.string().url(),
        alias: z.string().min(1).nullable().optional(),
        api_kind: z.enum(['openai', 'anthropic']).optional(),
        api_key: z.string().min(1).optional(),
        models: z.array(z.string().min(1)).optional(),
      }),
    },
    async ({ name, base_url, alias, api_kind, api_key, models }) =>
      result(
        (async () => {
          const modelDtos =
            models && models.length > 0
              ? models.map((model_name) => ({ model_name }))
              : await deps.customProviders
                  .probeModels(base_url, api_key, api_kind ?? 'openai', name)
                  .then((probed) => probed.map((m) => ({ model_name: m.model_name })));
          if (modelDtos.length === 0) {
            throw new Error('No models found at the endpoint; pass models explicitly');
          }
          const created = await deps.customProviders.create(
            operator.tenantId,
            { name, alias, base_url, api_kind, apiKey: api_key, models: modelDtos },
            operator.userId,
          );
          return { id: created.id, name: created.name, alias: created.alias };
        })(),
      ),
  );

  server.registerTool(
    'manifest_provider_custom_remove',
    {
      title: 'Remove a custom provider',
      description: 'Delete a custom provider registration by name.',
      inputSchema: z.object({ name: z.string().min(1) }),
    },
    async ({ name }) =>
      result(
        (async () => {
          const match = (await deps.customProviders.list(operator.tenantId)).find(
            (c) => c.name === name || c.alias === name,
          );
          if (!match) throw new Error(`Custom provider "${name}" not found`);
          await deps.customProviders.remove(operator.tenantId, match.id, operator.userId);
          return { removed: true, name };
        })(),
      ),
  );

  server.registerTool(
    'manifest_agent_provider_enable',
    {
      title: 'Enable a provider for an agent',
      description: 'Grant one provider connection to a harness.',
      inputSchema: z.object({
        agent: z.string().min(1),
        provider: z.string().min(1),
        auth_type: z.enum(AUTH_TYPES).optional(),
        label: z.string().min(1).optional(),
      }),
    },
    async ({ agent, provider, auth_type, label }) =>
      result(setAgentProviderEnabled(deps, operator, agent, provider, auth_type, label, true)),
  );

  server.registerTool(
    'manifest_agent_provider_disable',
    {
      title: 'Disable a provider for an agent',
      description: 'Revoke one provider connection from a harness.',
      inputSchema: z.object({
        agent: z.string().min(1),
        provider: z.string().min(1),
        auth_type: z.enum(AUTH_TYPES).optional(),
        label: z.string().min(1).optional(),
      }),
    },
    async ({ agent, provider, auth_type, label }) =>
      result(setAgentProviderEnabled(deps, operator, agent, provider, auth_type, label, false)),
  );
}

async function setAgentProviderEnabled(
  deps: McpToolDeps,
  operator: McpOperator,
  agentName: string,
  provider: string,
  authType: ('api_key' | 'subscription' | 'local') | undefined,
  label: string | undefined,
  enabled: boolean,
): Promise<unknown> {
  const agent = await deps.resolveAgent.resolve(operator.tenantId, agentName);
  const connections = await deps.providers.getProviders(agent.tenant_id);
  const connection = connections.find(
    (p) =>
      p.provider === provider &&
      (authType === undefined || p.auth_type === authType) &&
      (label === undefined || p.label === label),
  );
  if (!connection) {
    throw new Error(`No ${provider} connection matches the given auth type/label`);
  }
  if (enabled) {
    await deps.agentEnabledProviderRepo
      .createQueryBuilder()
      .insert()
      .into(AgentEnabledProvider)
      .values({ agent_id: agent.id, tenant_provider_id: connection.id })
      .orIgnore()
      .execute();
  } else {
    await deps.agentEnabledProviderRepo.delete({
      agent_id: agent.id,
      tenant_provider_id: connection.id,
    });
  }
  await deps.providers.recalculateTiers(agent.id, agent.tenant_id);
  return { ok: true, agent: agent.name, provider, enabled };
}
