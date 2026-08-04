import { TenantContext } from '../common/decorators/tenant-context.decorator';
import { WorkspaceDefaultsService } from '../common/services/workspace-defaults.service';
import { Tenant } from '../entities/tenant.entity';
import { Repository } from 'typeorm';
import { WorkspaceDefaultsController } from './workspace-defaults.controller';

describe('WorkspaceDefaultsController', () => {
  const ctx = { tenantId: 't1', userId: 'u1' } as TenantContext;
  let tenantRepo: { update: jest.Mock };
  let workspaceDefaults: { get: jest.Mock; invalidate: jest.Mock };
  let controller: WorkspaceDefaultsController;

  beforeEach(() => {
    tenantRepo = { update: jest.fn().mockResolvedValue(undefined) };
    workspaceDefaults = {
      get: jest.fn().mockResolvedValue({ autofix: null, recording: null }),
      invalidate: jest.fn(),
    };
    controller = new WorkspaceDefaultsController(
      tenantRepo as unknown as Repository<Tenant>,
      workspaceDefaults as unknown as WorkspaceDefaultsService,
    );
  });

  it('GET returns the resolved workspace defaults', async () => {
    workspaceDefaults.get.mockResolvedValueOnce({ autofix: true, recording: false });
    await expect(controller.get(ctx)).resolves.toEqual({ autofix: true, recording: false });
    expect(workspaceDefaults.get).toHaveBeenCalledWith('t1');
  });

  it('PATCH writes only the keys present in the body', async () => {
    await controller.update(ctx, { autofix: true });
    expect(tenantRepo.update).toHaveBeenCalledWith('t1', { autofix_default_enabled: true });
  });

  it('PATCH writes both keys when both are sent', async () => {
    await controller.update(ctx, { autofix: false, recording: true });
    expect(tenantRepo.update).toHaveBeenCalledWith('t1', {
      autofix_default_enabled: false,
      recording_default_enabled: true,
    });
  });

  it('PATCH treats an explicit null as "clear the workspace choice"', async () => {
    await controller.update(ctx, { autofix: null });
    expect(tenantRepo.update).toHaveBeenCalledWith('t1', { autofix_default_enabled: null });
  });

  it('PATCH invalidates the cache so the next read is fresh', async () => {
    await controller.update(ctx, { recording: false });
    expect(workspaceDefaults.invalidate).toHaveBeenCalledWith('t1');
  });

  it('PATCH with an empty body writes nothing and just reads back', async () => {
    await expect(controller.update(ctx, {})).resolves.toEqual({ autofix: null, recording: null });
    expect(tenantRepo.update).not.toHaveBeenCalled();
    expect(workspaceDefaults.invalidate).not.toHaveBeenCalled();
  });

  it('PATCH without a resolved tenant reads back instead of writing', async () => {
    const anon = { tenantId: null, userId: 'u1' } as unknown as TenantContext;
    await expect(controller.update(anon, { autofix: true })).resolves.toEqual({
      autofix: null,
      recording: null,
    });
    expect(tenantRepo.update).not.toHaveBeenCalled();
  });
});
