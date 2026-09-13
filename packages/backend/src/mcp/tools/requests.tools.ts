import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { McpOperator } from '../mcp-auth';
import { McpToolDeps } from '../tool-deps';
import { err, ok } from '../tool-result';

function result(promise: Promise<unknown>) {
  return promise.then(ok).catch((e: unknown) => err(e instanceof Error ? e.message : String(e)));
}

/**
 * Request ledger readout. Mirrors the API's opaque-cursor pagination: one page
 * per call, `next_cursor` for the following page.
 */
export function registerRequestTools(
  server: McpServer,
  deps: McpToolDeps,
  operator: McpOperator,
): void {
  server.registerTool(
    'manifest_requests_get',
    {
      title: 'Get requests',
      description: 'List recent Manifest requests (provider attempts) with cursor pagination.',
      inputSchema: z.object({
        agent: z.string().min(1).optional(),
        range: z.string().min(1).optional(),
        status: z.string().min(1).optional(),
        provider: z.string().min(1).optional(),
        origin: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().min(1).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ agent, range, status, provider, origin, limit, cursor }) =>
      result(
        (async () => {
          const page = (await deps.messages.getMessages({
            tenantId: operator.tenantId,
            agent_name: agent,
            range,
            status: status as never,
            provider,
            origin: origin as never,
            limit: Math.min(limit ?? 50, 200),
            cursor,
          })) as {
            items?: unknown[];
            next_cursor?: string | null;
            total_count?: number;
          };
          return {
            items: page.items ?? [],
            next_cursor: page.next_cursor ?? null,
            total_count: page.total_count ?? 0,
          };
        })(),
      ),
  );
}
