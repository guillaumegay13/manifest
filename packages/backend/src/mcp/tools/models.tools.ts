import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { McpOperator } from '../mcp-auth';
import { McpToolDeps } from '../tool-deps';
import { err, ok } from '../tool-result';

function result(promise: Promise<unknown>) {
  return promise.then(ok).catch((e: unknown) => err(e instanceof Error ? e.message : String(e)));
}

/** Model discovery and pricing readouts. */
export function registerModelTools(
  server: McpServer,
  deps: McpToolDeps,
  _operator: McpOperator,
): void {
  server.registerTool(
    'manifest_models_list',
    {
      title: 'List available models',
      description: 'List the models the harness can route to, per connected provider.',
      inputSchema: z.object({ agent: z.string().min(1) }),
      annotations: { readOnlyHint: true },
    },
    async ({ agent: agentName }) =>
      result(
        (async () => {
          const agent = await deps.resolveAgent.resolve(_operator.tenantId, agentName, {
            allowPlayground: true,
          });
          const models = await deps.modelDiscovery.getModelsForAgent(agent.tenant_id, agent.id);
          return {
            models: models.map((m) => ({
              id: m.id,
              provider: m.provider,
              display_name: m.displayName ?? null,
            })),
          };
        })(),
      ),
  );

  server.registerTool(
    'manifest_model_prices',
    {
      title: 'Model prices',
      description: 'Install-wide model pricing. No agent is required.',
      inputSchema: z.object({ provider: z.string().min(1).optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ provider }) =>
      result(
        (async () => {
          const { models, lastSyncedAt } = deps.modelPrices.getAll();
          return {
            models: models.filter((row) => provider === undefined || row.provider === provider),
            lastSyncedAt,
          };
        })(),
      ),
  );
}
