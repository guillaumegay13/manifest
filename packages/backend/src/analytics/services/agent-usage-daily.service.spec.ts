import { AgentUsageDailyService } from './agent-usage-daily.service';

describe('AgentUsageDailyService', () => {
  const originalReads = process.env['AGENT_USAGE_DAILY_READS'];
  const originalTenants = process.env['AGENT_USAGE_DAILY_READ_TENANTS'];

  afterEach(() => {
    if (originalReads === undefined) delete process.env['AGENT_USAGE_DAILY_READS'];
    else process.env['AGENT_USAGE_DAILY_READS'] = originalReads;
    if (originalTenants === undefined) delete process.env['AGENT_USAGE_DAILY_READ_TENANTS'];
    else process.env['AGENT_USAGE_DAILY_READ_TENANTS'] = originalTenants;
  });

  it('keeps reads off by default and supports a selected-tenant rollout', () => {
    delete process.env['AGENT_USAGE_DAILY_READS'];
    process.env['AGENT_USAGE_DAILY_READ_TENANTS'] = 'tenant-a, tenant-b';
    const service = new AgentUsageDailyService({} as never);

    expect(service.readsEnabledFor('tenant-a')).toBe(true);
    expect(service.readsEnabledFor('tenant-c')).toBe(false);
    expect(service.readsEnabledFor(null)).toBe(false);
  });

  it('supports the global read cutover', () => {
    process.env['AGENT_USAGE_DAILY_READS'] = 'true';
    const service = new AgentUsageDailyService({} as never);
    expect(service.readsEnabledFor('tenant-c')).toBe(true);
  });

  it('reads only the bounded tenant window', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new AgentUsageDailyService({ query } as never);

    await service.getRows('tenant-a');

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('FROM "agent_usage_daily"');
    expect(query.mock.calls[0][0]).toContain('"tenant_id" = $1');
    expect(query.mock.calls[0][0]).toContain('"day" >= $2::date');
    expect(query.mock.calls[0][1][0]).toBe('tenant-a');
  });

  it('does no work when another replica owns the transaction lock', async () => {
    const manager = {
      query: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ acquired: false }]),
    };
    const dataSource = { transaction: (run: (value: unknown) => unknown) => run(manager) };
    const service = new AgentUsageDailyService(dataSource as never);

    await expect(service.processBatch()).resolves.toEqual({
      acquired: false,
      processed: 0,
      rollups: 0,
    });
    expect(manager.query).toHaveBeenCalledTimes(3);
  });

  it('upserts increments and marks the same locked Requests in one transaction', async () => {
    const manager = {
      query: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ acquired: true }])
        .mockResolvedValueOnce([{ processed: 2, rollups: 3 }]),
    };
    const dataSource = { transaction: (run: (value: unknown) => unknown) => run(manager) };
    const service = new AgentUsageDailyService(dataSource as never);

    await expect(service.processBatch(2)).resolves.toEqual({
      acquired: true,
      processed: 2,
      rollups: 3,
    });
    const sql = manager.query.mock.calls[3][0] as string;
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('ON CONFLICT ("tenant_id", "agent_id", "day") DO UPDATE');
    expect(sql).toContain('SET "agent_usage_rolled_up_at" = NOW()');
    expect(sql.indexOf('upserted AS')).toBeLessThan(sql.indexOf('marked AS'));
    expect(manager.query.mock.calls[3][1][0]).toBe(2);
  });
});
