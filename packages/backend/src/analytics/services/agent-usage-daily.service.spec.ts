import { AgentUsageDailyService } from './agent-usage-daily.service';

describe('AgentUsageDailyService', () => {
  const originalReads = process.env['AGENT_USAGE_DAILY_READS'];
  const originalTenants = process.env['AGENT_USAGE_DAILY_READ_TENANTS'];
  const originalWorker = process.env['AGENT_USAGE_DAILY_WORKER'];
  const originalBatchSize = process.env['AGENT_USAGE_DAILY_BATCH_SIZE'];
  const originalRunBudget = process.env['AGENT_USAGE_DAILY_RUN_BUDGET_MS'];

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalReads === undefined) delete process.env['AGENT_USAGE_DAILY_READS'];
    else process.env['AGENT_USAGE_DAILY_READS'] = originalReads;
    if (originalTenants === undefined) delete process.env['AGENT_USAGE_DAILY_READ_TENANTS'];
    else process.env['AGENT_USAGE_DAILY_READ_TENANTS'] = originalTenants;
    if (originalWorker === undefined) delete process.env['AGENT_USAGE_DAILY_WORKER'];
    else process.env['AGENT_USAGE_DAILY_WORKER'] = originalWorker;
    if (originalBatchSize === undefined) delete process.env['AGENT_USAGE_DAILY_BATCH_SIZE'];
    else process.env['AGENT_USAGE_DAILY_BATCH_SIZE'] = originalBatchSize;
    if (originalRunBudget === undefined) delete process.env['AGENT_USAGE_DAILY_RUN_BUDGET_MS'];
    else process.env['AGENT_USAGE_DAILY_RUN_BUDGET_MS'] = originalRunBudget;
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

  it('skips scheduled work when disabled or already running', async () => {
    const service = new AgentUsageDailyService({} as never);
    const processBatch = jest.spyOn(service, 'processBatch');

    process.env['AGENT_USAGE_DAILY_WORKER'] = 'false';
    await service.runScheduled();

    delete process.env['AGENT_USAGE_DAILY_WORKER'];
    (service as unknown as { running: boolean }).running = true;
    await service.runScheduled();

    expect(processBatch).not.toHaveBeenCalled();
  });

  it('runs scheduled batches until the queue returns a partial batch', async () => {
    process.env['AGENT_USAGE_DAILY_BATCH_SIZE'] = '2';
    process.env['AGENT_USAGE_DAILY_RUN_BUDGET_MS'] = '5000';
    const service = new AgentUsageDailyService({} as never);
    const processBatch = jest
      .spyOn(service, 'processBatch')
      .mockResolvedValueOnce({ acquired: true, processed: 2, rollups: 1 })
      .mockResolvedValueOnce({ acquired: true, processed: 1, rollups: 1 });
    const logger = (service as unknown as { logger: { log: (message: string) => void } }).logger;
    const log = jest.spyOn(logger, 'log').mockImplementation();

    await service.runScheduled();

    expect(processBatch).toHaveBeenCalledTimes(2);
    expect(processBatch).toHaveBeenCalledWith(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('processed 3 request(s)'));
    expect((service as unknown as { running: boolean }).running).toBe(false);
  });

  it('stops scheduled work when another replica owns the lock', async () => {
    const service = new AgentUsageDailyService({} as never);
    const processBatch = jest
      .spyOn(service, 'processBatch')
      .mockResolvedValue({ acquired: false, processed: 0, rollups: 0 });

    await service.runScheduled();

    expect(processBatch).toHaveBeenCalledTimes(1);
    expect((service as unknown as { running: boolean }).running).toBe(false);
  });

  it('logs scheduled failures, uses safe defaults, and releases the runner', async () => {
    process.env['AGENT_USAGE_DAILY_BATCH_SIZE'] = '0';
    process.env['AGENT_USAGE_DAILY_RUN_BUDGET_MS'] = 'invalid';
    const service = new AgentUsageDailyService({} as never);
    const processBatch = jest
      .spyOn(service, 'processBatch')
      .mockRejectedValue(new Error('db down'));
    const logger = (service as unknown as { logger: { error: (message: string) => void } }).logger;
    const error = jest.spyOn(logger, 'error').mockImplementation();

    await service.runScheduled();

    expect(processBatch).toHaveBeenCalledWith(1_000);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('db down'));
    expect((service as unknown as { running: boolean }).running).toBe(false);
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
