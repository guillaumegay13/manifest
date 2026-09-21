import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { agentUsageDailyReadsEnabled } from '../../common/utils/agent-usage-daily-flags';

const AGENT_USAGE_ROLLUP_LOCK_KEY = 1_802_700_000;
const DEFAULT_BATCH_SIZE = 1_000;
const DEFAULT_RUN_BUDGET_MS = 5_000;

export interface AgentUsageDailyRow {
  agent_id: string;
  day: string;
  request_count: string;
  input_tokens: string;
  output_tokens: string;
  cost_usd: string;
  last_active_at: string | Date | null;
}

export interface AgentUsageBatchResult {
  acquired: boolean;
  processed: number;
  rollups: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function utcDateDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

@Injectable()
export class AgentUsageDailyService {
  private readonly logger = new Logger(AgentUsageDailyService.name);
  private running = false;

  constructor(private readonly dataSource: DataSource) {}

  readsEnabledFor(tenantId: string | null): boolean {
    return agentUsageDailyReadsEnabled(tenantId);
  }

  async getRows(tenantId: string): Promise<AgentUsageDailyRow[]> {
    return (await this.dataSource.query(
      `SELECT
         "agent_id",
         "day"::text AS "day",
         "request_count"::text AS "request_count",
         "input_tokens"::text AS "input_tokens",
         "output_tokens"::text AS "output_tokens",
         "cost_usd"::text AS "cost_usd",
         "last_active_at"
       FROM "agent_usage_daily"
       WHERE "tenant_id" = $1
         AND "day" >= $2::date
       ORDER BY "agent_id" ASC, "day" ASC`,
      [tenantId, utcDateDaysAgo(29)],
    )) as AgentUsageDailyRow[];
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async runScheduled(): Promise<void> {
    if (process.env['AGENT_USAGE_DAILY_WORKER'] === 'false' || this.running) return;
    this.running = true;
    const startedAt = Date.now();
    let processed = 0;
    let rollups = 0;
    try {
      const batchSize = positiveInteger(
        process.env['AGENT_USAGE_DAILY_BATCH_SIZE'],
        DEFAULT_BATCH_SIZE,
      );
      const budgetMs = positiveInteger(
        process.env['AGENT_USAGE_DAILY_RUN_BUDGET_MS'],
        DEFAULT_RUN_BUDGET_MS,
      );
      do {
        const result = await this.processBatch(batchSize);
        if (!result.acquired) break;
        processed += result.processed;
        rollups += result.rollups;
        if (result.processed < batchSize) break;
      } while (Date.now() - startedAt < budgetMs);

      if (processed > 0) {
        this.logger.log(
          `agent usage rollup: processed ${processed} request(s), wrote ${rollups} daily row(s) in ${Date.now() - startedAt}ms`,
        );
      }
    } catch (error) {
      this.logger.error(
        `agent usage rollup failed after ${processed} request(s): ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  async processBatch(batchSize = DEFAULT_BATCH_SIZE): Promise<AgentUsageBatchResult> {
    const storageTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL lock_timeout = '250ms'`);
      await manager.query(`SET LOCAL statement_timeout = '5s'`);
      const lockRows = (await manager.query(
        `SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired`,
        [AGENT_USAGE_ROLLUP_LOCK_KEY],
      )) as Array<{ acquired: boolean }>;
      if (lockRows[0]?.acquired !== true) {
        return { acquired: false, processed: 0, rollups: 0 };
      }

      const rows = (await manager.query(
        `WITH selected AS MATERIALIZED (
           SELECT r."id", r."tenant_id", r."agent_id", r."timestamp", r."status"
           FROM "requests" r
           WHERE r."agent_usage_rolled_up_at" IS NULL
             AND r."status" IN ('success', 'failed')
             AND r."tenant_id" IS NOT NULL
             AND r."agent_id" IS NOT NULL
           ORDER BY r."timestamp" DESC, r."id" DESC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         ), request_rollups AS (
           SELECT
             s."tenant_id",
             s."agent_id",
             (((s."timestamp" AT TIME ZONE $2) AT TIME ZONE 'UTC')::date) AS "day",
             COUNT(*)::bigint AS "request_count",
             COUNT(*) FILTER (WHERE s."status" = 'success')::bigint AS "successful_request_count",
             COUNT(*) FILTER (WHERE s."status" = 'failed')::bigint AS "failed_request_count",
             0::bigint AS "input_tokens",
             0::bigint AS "output_tokens",
             0::numeric AS "cost_usd",
             MAX(s."timestamp") AS "last_active_at"
           FROM selected s
           GROUP BY s."tenant_id", s."agent_id", "day"
         ), attempt_rollups AS (
           SELECT
             s."tenant_id",
             s."agent_id",
             (((pa."timestamp" AT TIME ZONE $2) AT TIME ZONE 'UTC')::date) AS "day",
             0::bigint AS "request_count",
             0::bigint AS "successful_request_count",
             0::bigint AS "failed_request_count",
             COALESCE(SUM(pa."input_tokens"), 0)::bigint AS "input_tokens",
             COALESCE(SUM(pa."output_tokens"), 0)::bigint AS "output_tokens",
             COALESCE(SUM(CASE WHEN pa."cost_usd" >= 0 THEN pa."cost_usd" ELSE 0 END), 0)::numeric AS "cost_usd",
             MAX(pa."timestamp") AS "last_active_at"
           FROM selected s
           JOIN "agent_messages" pa ON pa."request_id" = s."id"
           WHERE pa."status" IS NULL OR pa."status" NOT IN ('pending', 'cancelled')
           GROUP BY s."tenant_id", s."agent_id", "day"
         ), increments AS (
           SELECT
             "tenant_id",
             "agent_id",
             "day",
             SUM("request_count")::bigint AS "request_count",
             SUM("successful_request_count")::bigint AS "successful_request_count",
             SUM("failed_request_count")::bigint AS "failed_request_count",
             SUM("input_tokens")::bigint AS "input_tokens",
             SUM("output_tokens")::bigint AS "output_tokens",
             SUM("cost_usd")::numeric AS "cost_usd",
             MAX("last_active_at") AS "last_active_at"
           FROM (
             SELECT * FROM request_rollups
             UNION ALL
             SELECT * FROM attempt_rollups
           ) combined
           GROUP BY "tenant_id", "agent_id", "day"
         ), upserted AS (
           INSERT INTO "agent_usage_daily" (
             "tenant_id", "agent_id", "day", "request_count",
             "successful_request_count", "failed_request_count", "input_tokens",
             "output_tokens", "cost_usd", "last_active_at", "updated_at"
           )
           SELECT
             "tenant_id", "agent_id", "day", "request_count",
             "successful_request_count", "failed_request_count", "input_tokens",
             "output_tokens", "cost_usd", "last_active_at", NOW()
           FROM increments
           ON CONFLICT ("tenant_id", "agent_id", "day") DO UPDATE SET
             "request_count" = "agent_usage_daily"."request_count" + EXCLUDED."request_count",
             "successful_request_count" = "agent_usage_daily"."successful_request_count" + EXCLUDED."successful_request_count",
             "failed_request_count" = "agent_usage_daily"."failed_request_count" + EXCLUDED."failed_request_count",
             "input_tokens" = "agent_usage_daily"."input_tokens" + EXCLUDED."input_tokens",
             "output_tokens" = "agent_usage_daily"."output_tokens" + EXCLUDED."output_tokens",
             "cost_usd" = "agent_usage_daily"."cost_usd" + EXCLUDED."cost_usd",
             "last_active_at" = GREATEST("agent_usage_daily"."last_active_at", EXCLUDED."last_active_at"),
             "updated_at" = NOW()
           RETURNING 1
         ), marked AS (
           UPDATE "requests" r
           SET "agent_usage_rolled_up_at" = NOW()
           FROM selected s, (SELECT COUNT(*) FROM upserted) ready
           WHERE r."id" = s."id"
           RETURNING 1
         )
         SELECT
           (SELECT COUNT(*)::int FROM marked) AS processed,
           (SELECT COUNT(*)::int FROM upserted) AS rollups`,
        [Math.max(1, Math.floor(batchSize)), storageTimeZone],
      )) as Array<{ processed: number | string; rollups: number | string }>;

      return {
        acquired: true,
        processed: Number(rows[0]?.processed ?? 0),
        rollups: Number(rows[0]?.rollups ?? 0),
      };
    });
  }
}
