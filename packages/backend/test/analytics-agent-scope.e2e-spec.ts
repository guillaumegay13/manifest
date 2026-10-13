import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { v4 as uuid } from 'uuid';
import { toLocalSqlTimestamp } from '../src/common/utils/postgres-sql';
import { createTestApp, TEST_API_KEY, TEST_TENANT_ID } from './helpers';

let app: INestApplication;
const foreignTenant = uuid();
const liveId = uuid();
const retiredId = uuid();
const otherId = uuid();
const foreignId = uuid();
const harness = 'scope-reused-name';

// Each harness has three logical requests but three provider attempts:
// a recovered request (two attempts), an unlinked success, and a setup failure
// with no provider call. Distinct amounts make accidental scope leaks visible.
async function seedHarness(
  ds: DataSource,
  tenantId: string,
  agentId: string,
  name: string,
  factor: number,
  deleted = false,
) {
  const timestamp = toLocalSqlTimestamp(new Date(Date.now() - 10 * 60_000));
  await ds.query(
    `INSERT INTO agents (id, tenant_id, name, display_name, deleted_at)
     VALUES ($1, $2, $3, $3, $4)`,
    [agentId, tenantId, name, deleted ? timestamp : null],
  );
  const requestId = uuid();
  await ds.query(
    `INSERT INTO requests (id, tenant_id, agent_id, agent_name, timestamp, status)
     VALUES ($1, $2, $3, $4, $5, 'success'), ($6, $2, $3, $4, $5, 'error')`,
    [requestId, tenantId, agentId, name, timestamp, uuid()],
  );
  for (const [index, tokens] of [10, 30, 50].entries()) {
    await ds.query(
      `INSERT INTO agent_messages
       (id, tenant_id, agent_id, agent_name, request_id, timestamp, status,
        model, provider, auth_type, input_tokens, output_tokens, cost_usd,
        error_origin, error_class, superseded)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'openai', 'api_key', $9, 0, $10,
               $11, $12, $13)`,
      [
        uuid(), tenantId, agentId, name, index < 2 ? requestId : null, timestamp,
        index === 0 ? 'error' : 'success', `${agentId}-model`, tokens * factor,
        (tokens * factor) / 100, index === 0 ? 'provider' : null,
        index === 0 ? 'rate_limit' : null, index === 0,
      ],
    );
  }
}

beforeAll(async () => {
  app = await createTestApp();
  const ds = app.get(DataSource);
  await ds.query(
    `INSERT INTO tenants (id, name, owner_user_id) VALUES ($1, 'Foreign', 'scope-foreign-user')`,
    [foreignTenant],
  );
  await seedHarness(ds, TEST_TENANT_ID, retiredId, harness, 10, true);
  await seedHarness(ds, TEST_TENANT_ID, liveId, harness, 1);
  await seedHarness(ds, TEST_TENANT_ID, otherId, 'scope-other', 100);
  await seedHarness(ds, foreignTenant, foreignId, harness, 1000);
});

afterAll(async () => {
  await app?.close();
});

async function get(path: string, agentName?: string, userId?: string) {
  const call = request(app.getHttpServer())
    .get(`/api/v1/${path}`)
    .query({ range: '24h', ...(agentName ? { agent_name: agentName } : {}) })
    .set('x-api-key', TEST_API_KEY);
  if (userId) call.set('x-test-user-id', userId);
  return (await call.expect(200)).body;
}

const surfaces = [
  'messages', 'overview', 'overview/details', 'tokens', 'costs',
  'overview/autofix-stats', 'overview/autofix-timeseries',
  'overview/attempt-stats', 'errors/breakdown',
] as const;

function assertTotals(surface: typeof surfaces[number], body: any, requests: number, tokens: number) {
  switch (surface) {
    case 'messages':
      expect(body.total_count).toBe(requests);
      expect(body.items).toHaveLength(requests);
      break;
    case 'overview':
      expect(body.summary.messages.value).toBe(requests);
      expect(body.summary.tokens_today.value).toBe(tokens);
      expect(body.summary.cost_today.value).toBeCloseTo(tokens / 100);
      expect(body.request_reliability.recovered).toBe(requests / 3);
      break;
    case 'overview/details':
      expect(body.request_reliability.total).toBe(requests);
      expect(body.cost_by_model.reduce((sum: number, row: any) => sum + row.estimated_cost, 0))
        .toBeCloseTo(tokens / 100);
      break;
    case 'tokens':
      expect(body.summary.total_tokens.value).toBe(tokens);
      break;
    case 'costs':
      expect(body.summary.weekly_cost.value).toBeCloseTo(tokens / 100);
      break;
    case 'overview/autofix-stats':
      expect(body.total_requests.value).toBe(requests);
      expect(body.errors_remaining.value).toBe(requests / 3);
      break;
    case 'overview/autofix-timeseries':
      expect(body.buckets.reduce((sum: number, row: any) =>
        sum + row.counts.reduce((a: number, b: number) => a + b, 0), 0)).toBe(requests);
      break;
    case 'overview/attempt-stats':
      expect(body.total_attempts.value).toBe(requests);
      break;
    case 'errors/breakdown':
      expect(body.provider_errors).toBe(requests / 3);
      expect(body.successful).toBe((requests * 2) / 3);
      break;
  }
}

describe.each(surfaces)('analytics scope: GET %s', (surface) => {
  it('selects only the live harness, including linked and legacy rows', async () => {
    assertTotals(surface, await get(surface, harness), 3, 90);
  });

  it('keeps historical and other-harness data in the tenant-wide view', async () => {
    assertTotals(surface, await get(surface), 9, 9990);
  });

  it('resolves the same name independently in another tenant', async () => {
    assertTotals(surface, await get(surface, harness, 'scope-foreign-user'), 3, 90000);
  });

  it('returns empty data for a missing harness', async () => {
    assertTotals(surface, await get(surface, 'scope-missing'), 0, 0);
  });

  it('returns empty data for an authenticated user without a tenant', async () => {
    assertTotals(surface, await get(surface, harness, 'scope-no-tenant-user'), 0, 0);
  });
});

it('keeps list rows and filter options free of the retired and foreign harnesses', async () => {
  const body = await get('messages', harness);
  expect(body.items.filter((row: any) => row.model).map((row: any) => row.model))
    .toEqual([`${liveId}-model`, `${liveId}-model`]);
  expect(body.models).toEqual([`${liveId}-model`]);
});
