# Agent usage daily rollup

Status: Proposed

## Summary

Manifest will store dashboard usage in a new `agent_usage_daily` table. One row
contains one UTC day of usage for one tenant and one agent.

`GET /api/v1/agents` will read this table instead of aggregating 30 days of raw
`requests` and `agent_messages` rows. The API response will not change.

The rollup worker will process completed Requests asynchronously. Dashboard
usage can lag live traffic by up to one minute. Request routing and recording
must not wait for the rollup.

## Problem

The current agent-list query calculates these values on every cache miss:

- completed Request count for the last 30 days;
- total input tokens, output tokens, and cost for the last 30 days;
- last activity;
- seven daily token buckets for the sparkline.

The query reads `requests`, linked `agent_messages`, and legacy unlinked
`agent_messages`. The indexes reduce the search space, but PostgreSQL must still
read and aggregate each matching row. The result cache lasts 60 seconds, lives
inside each backend process, and is invalidated after message activity. A cold
request can therefore take more than 30 seconds while the next request is fast.

## Goals

- Make the cold `GET /api/v1/agents` cost proportional to agents and days, not
  raw traffic volume.
- Keep the existing API response and metric meanings.
- Keep rollup work outside the customer request path.
- Make rollup writes idempotent across crashes and multiple backend replicas.
- Remove the agent-list response cache and its message-driven invalidation.
- Remove the legacy Request/Attempt compatibility scans after the Request
  transition is complete.

## Non-goals

- This table does not replace `requests` or `agent_messages`.
- This table does not provide Provider, Connection, or model analytics.
- This change does not move customer analytics to Peacock.
- This change does not make dashboard usage strongly consistent with the most
  recent Request.
- This change does not add hourly or arbitrary rollup grains.

## Data model

### `agent_usage_daily`

```sql
CREATE TABLE agent_usage_daily (
  tenant_id varchar NOT NULL,
  agent_id varchar NOT NULL,
  day date NOT NULL,
  request_count bigint NOT NULL DEFAULT 0,
  successful_request_count bigint NOT NULL DEFAULT 0,
  failed_request_count bigint NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cost_usd numeric(20, 8) NOT NULL DEFAULT 0,
  last_active_at timestamp NULL,
  updated_at timestamp NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, agent_id, day),
  CONSTRAINT fk_agent_usage_daily_agent
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
```

The primary key supports the complete read predicate:

```text
tenant_id = ? AND day >= ?
```

No second index is required for the initial read path.

### Request marker

Add a nullable marker to `requests`:

```sql
ALTER TABLE requests
  ADD COLUMN agent_usage_rolled_up_at timestamp NULL;
```

Add a partial queue index without blocking production writes:

```sql
CREATE INDEX CONCURRENTLY idx_requests_agent_usage_pending
  ON requests (timestamp, id)
  WHERE agent_usage_rolled_up_at IS NULL
    AND status IN ('success', 'failed')
    AND tenant_id IS NOT NULL
    AND agent_id IS NOT NULL;
```

The marker is the durable queue state. It also gives the worker exactly-once
behavior without an external queue or an event table.

The migration that creates the concurrent index must run outside a transaction.
Adding the nullable marker must not rewrite existing `requests` rows.

## Metric contract

The definitions in [the analytics glossary](./glossary.md) remain authoritative.

| Rollup column              | Source and rule                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `request_count`            | One for each completed Request: `requests.status IN ('success', 'failed')`.                                             |
| `successful_request_count` | One when `requests.status = 'success'`.                                                                                 |
| `failed_request_count`     | One when `requests.status = 'failed'`.                                                                                  |
| `input_tokens`             | Sum of `agent_messages.input_tokens` for completed Provider Attempts.                                                   |
| `output_tokens`            | Sum of `agent_messages.output_tokens` for completed Provider Attempts.                                                  |
| `cost_usd`                 | Sum of non-negative `agent_messages.cost_usd` for completed Provider Attempts. Null and negative costs contribute zero. |
| `last_active_at`           | Latest contributing Request or Provider Attempt timestamp.                                                              |

Pending and cancelled Requests and Provider Attempts contribute nothing.

Request counters use the UTC day of `requests.timestamp`. Token and cost values
use the UTC day of `agent_messages.timestamp`. One Request can therefore update
more than one daily row if its Provider Attempts cross midnight.

All linked completed Provider Attempts contribute token and cost usage. A
fallback or Autofix chain can contain several Attempts, so its Attempt usage is
the sum of those Attempts while its Request count remains one.

Playground usage can exist in the rollup. User-facing readers continue to hide
Playground agents through the `agents.is_playground` rule.

## Rollup worker

Run the worker once per minute in the Manifest backend. All replicas can
schedule it, but a transaction-level PostgreSQL advisory lock allows only one
worker to process a batch at a time.

Each batch must use one database transaction:

1. Select up to 1,000 eligible completed Requests with
   `FOR UPDATE SKIP LOCKED`.
2. Aggregate Request counters by tenant, agent, and UTC day.
3. Aggregate completed linked Provider Attempt usage by tenant, agent, and UTC
   day.
4. Upsert the resulting increments into `agent_usage_daily`.
5. Set `requests.agent_usage_rolled_up_at = NOW()` for the selected Requests.
6. Commit.

The upsert adds counters and keeps the greatest `last_active_at`:

```sql
INSERT INTO agent_usage_daily (...)
VALUES (...)
ON CONFLICT (tenant_id, agent_id, day) DO UPDATE SET
  request_count = agent_usage_daily.request_count + EXCLUDED.request_count,
  successful_request_count =
    agent_usage_daily.successful_request_count + EXCLUDED.successful_request_count,
  failed_request_count =
    agent_usage_daily.failed_request_count + EXCLUDED.failed_request_count,
  input_tokens = agent_usage_daily.input_tokens + EXCLUDED.input_tokens,
  output_tokens = agent_usage_daily.output_tokens + EXCLUDED.output_tokens,
  cost_usd = agent_usage_daily.cost_usd + EXCLUDED.cost_usd,
  last_active_at = GREATEST(
    agent_usage_daily.last_active_at,
    EXCLUDED.last_active_at
  ),
  updated_at = NOW();
```

If the process stops before commit, both the increments and the markers roll
back. The next worker can safely process the same Requests. If commit succeeds,
the marker prevents a second increment.

The worker must stop after a fixed time budget per run. A slow or backlogged
rollup must not create sustained database pressure. The next scheduled run
continues from the remaining marker rows.

## Historical backfill

The same batch algorithm handles historical Requests. Process newest Requests
first so the active 30-day dashboard window becomes complete before older
history.

Before read cutover, verify all of these conditions:

1. The Request transition is complete for the dashboard window.
2. No eligible unlinked legacy Provider Attempts remain in that window.
3. No completed Request in that window has a null
   `agent_usage_rolled_up_at`.
4. Daily rollup totals match the existing query for selected tenants and days.

Continue the backfill outside the active window until all eligible historical
Requests have a marker. Throttle batch work when normal database latency or
connection pressure exceeds its operating threshold.

Do not run a full-table aggregate inside a schema migration. The migration only
creates the schema and queue index. Application backfill code performs the
data work in bounded transactions.

## Read path

`GET /api/v1/agents` keeps its current response shape. It performs:

1. One small query for active agent metadata.
2. One query for the tenant's last 30 UTC days from `agent_usage_daily`.
3. An in-process fold by `agent_id` that produces totals, `last_active`, and the
   seven-day token sparkline.

At most 30 rows per agent enter the fold. Raw `requests` and `agent_messages`
must not be read by this endpoint after cutover.

The endpoint continues to return:

```text
agent_name
display_name
agent_category
agent_platform
message_count
last_active
total_cost
total_tokens
sparkline
```

`message_count` maps to `request_count`. `total_tokens` is
`input_tokens + output_tokens`.

The first version does not split metadata and usage into separate public
endpoints. The rollup makes the combined response bounded and preserves API,
CLI, MCP, and frontend compatibility. A later UI change can render metadata
before usage without changing the storage design.

## Cache and event cleanup

After cutover:

- Remove `AgentListCacheInterceptor` from `GET /agents`.
- Remove `AGENT_LIST_CACHE_TTL_MS` and the agent-list cache key generation.
- Stop invalidating the agent-list cache from `IngestEventBusService`.
- Keep message events for frontend refresh behavior.
- Remove the 30-day raw aggregation and compatibility snapshot from
  `TimeseriesQueriesService.getAgentList`.

The rollup worker defines freshness. A local response cache must not hide or
correct rollup lag.

## Failure and recovery

- A worker failure does not affect Request routing or recording.
- Failed batches roll back and retry on the next run.
- Multiple replicas cannot double-count because selection, increments, and
  marker updates share one transaction.
- A completed Request with no Provider Attempt still increments Request counts
  with zero token and cost usage.
- Completed Request and Provider Attempt rows are immutable for rollup fields
  after their marker is set. Code that introduces a valid late correction must
  also define a rollup repair operation.
- The initial repair procedure pauses the worker, recomputes selected UTC days
  from raw data, replaces those daily rows, resets affected markers if needed,
  and resumes the worker.

## Observability

Expose these values in logs or metrics:

- oldest unprocessed completed Request age;
- number of eligible unprocessed Requests;
- Requests processed per batch;
- batch duration;
- last successful worker time;
- worker error count;
- daily parity difference during rollout.

Alert when the oldest unprocessed Request exceeds five minutes. The normal
freshness target is one minute, but the alert allows short deploy and database
pressure delays.

## Rollout

1. Deploy the table, Request marker, and partial queue index.
2. Deploy the worker with rollup reads disabled.
3. Backfill the latest 30 days, then continue through older history.
4. Run shadow reads and compare per-agent totals with the current raw query.
5. Enable rollup reads for internal or selected tenants.
6. Enable rollup reads globally.
7. Confirm cold and warm `GET /agents` latency are equivalent.
8. Remove the old raw query, response cache, and invalidation code.
9. Remove the temporary read switch after one stable release.

Rollback during steps 4–6 changes only the read switch. The worker can continue
to populate the table while the old read path remains active.

## Acceptance criteria

- A cold `GET /api/v1/agents` does not query `requests` or `agent_messages`.
- Cold p95 latency is below 500 ms for a tenant with 100 active agents and 30
  days of rollup rows under representative production load.
- A Request appears in usage no later than two minutes after it becomes
  completed under normal load.
- Replaying or retrying a failed worker batch does not change totals.
- Request, token, cost, last-activity, and sparkline parity pass for sampled
  tenants before global cutover.
- A backend restart does not cause a cold-query latency spike.
- Agent creation, update, soft deletion, and Playground filtering keep their
  current behavior.
