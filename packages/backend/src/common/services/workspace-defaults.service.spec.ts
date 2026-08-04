import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Tenant } from '../../entities/tenant.entity';
import { WorkspaceDefaultsService } from './workspace-defaults.service';

describe('WorkspaceDefaultsService', () => {
  const findOne = jest.fn();
  let service: WorkspaceDefaultsService;

  beforeEach(async () => {
    findOne.mockReset();
    const module = await Test.createTestingModule({
      providers: [
        WorkspaceDefaultsService,
        { provide: getRepositoryToken(Tenant), useValue: { findOne } },
      ],
    }).compile();
    service = module.get(WorkspaceDefaultsService);
  });

  it.each([[null], [undefined], ['']])('short-circuits a missing tenant id (%p)', async (id) => {
    await expect(service.get(id as string | null)).resolves.toEqual({
      autofix: null,
      recording: null,
    });
    expect(findOne).not.toHaveBeenCalled();
  });

  it('returns both stored defaults', async () => {
    findOne.mockResolvedValue({
      id: 't1',
      autofix_default_enabled: true,
      recording_default_enabled: false,
    });
    await expect(service.get('t1')).resolves.toEqual({ autofix: true, recording: false });
  });

  it('reports an unset column as "no workspace choice"', async () => {
    findOne.mockResolvedValue({
      id: 't1',
      autofix_default_enabled: null,
      recording_default_enabled: null,
    });
    await expect(service.get('t1')).resolves.toEqual({ autofix: null, recording: null });
  });

  it('treats an unknown tenant as "no workspace choice" rather than throwing', async () => {
    findOne.mockResolvedValue(null);
    await expect(service.get('ghost')).resolves.toEqual({ autofix: null, recording: null });
  });

  it('caches per tenant and refetches after invalidation', async () => {
    findOne
      .mockResolvedValueOnce({ id: 't1', autofix_default_enabled: true })
      .mockResolvedValueOnce({ id: 't1', autofix_default_enabled: false });

    await expect(service.get('t1')).resolves.toMatchObject({ autofix: true });
    await expect(service.get('t1')).resolves.toMatchObject({ autofix: true });
    expect(findOne).toHaveBeenCalledTimes(1);

    service.invalidate('t1');
    await expect(service.get('t1')).resolves.toMatchObject({ autofix: false });
    expect(findOne).toHaveBeenCalledTimes(2);
  });
});
