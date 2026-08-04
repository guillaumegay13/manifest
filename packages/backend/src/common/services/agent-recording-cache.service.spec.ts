import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Agent } from '../../entities/agent.entity';
import { AgentRecordingCacheService } from './agent-recording-cache.service';
import { WorkspaceDefaultsService } from './workspace-defaults.service';

describe('AgentRecordingCacheService', () => {
  const findOne = jest.fn();
  const workspaceGet = jest.fn();
  let service: AgentRecordingCacheService;

  beforeEach(async () => {
    findOne.mockReset();
    workspaceGet.mockReset().mockResolvedValue({ autofix: null, recording: null });
    const module = await Test.createTestingModule({
      providers: [
        AgentRecordingCacheService,
        { provide: getRepositoryToken(Agent), useValue: { findOne } },
        {
          provide: WorkspaceDefaultsService,
          useValue: { get: workspaceGet, invalidate: jest.fn() },
        },
      ],
    }).compile();
    service = module.get(AgentRecordingCacheService);
  });

  it('does not query for a missing agent id', async () => {
    await expect(service.isRecording(undefined)).resolves.toBe(false);
    expect(findOne).not.toHaveBeenCalled();
  });

  it('caches enabled flags and refreshes them after invalidation', async () => {
    findOne
      .mockResolvedValueOnce({ id: 'agent-1', record_messages: true, tenant_id: 't1' })
      .mockResolvedValueOnce({ id: 'agent-1', record_messages: false, tenant_id: 't1' });

    await expect(service.isRecording('agent-1')).resolves.toBe(true);
    await expect(service.isRecording('agent-1')).resolves.toBe(true);
    expect(findOne).toHaveBeenCalledTimes(1);

    service.invalidate('agent-1');
    await expect(service.isRecording('agent-1')).resolves.toBe(false);
    expect(findOne).toHaveBeenCalledTimes(2);
  });

  it('treats an unknown agent as not recording', async () => {
    findOne.mockResolvedValueOnce(null);
    await expect(service.isRecording('ghost')).resolves.toBe(false);
    expect(workspaceGet).not.toHaveBeenCalled();
  });

  it('inherits the workspace default when the agent made no choice', async () => {
    findOne.mockResolvedValue({ id: 'agent-2', record_messages: null, tenant_id: 't1' });
    workspaceGet.mockResolvedValue({ autofix: null, recording: false });
    await expect(service.isRecording('agent-2')).resolves.toBe(false);
    expect(workspaceGet).toHaveBeenCalledWith('t1');
  });

  it('falls back to on when neither the agent nor the workspace chose', async () => {
    findOne.mockResolvedValue({ id: 'agent-3', record_messages: null, tenant_id: 't1' });
    await expect(service.isRecording('agent-3')).resolves.toBe(true);
  });

  it('lets an explicit agent choice outrank the workspace default', async () => {
    findOne.mockResolvedValue({ id: 'agent-4', record_messages: true, tenant_id: 't1' });
    workspaceGet.mockResolvedValue({ autofix: null, recording: false });
    await expect(service.isRecording('agent-4')).resolves.toBe(true);
    expect(workspaceGet).not.toHaveBeenCalled();
  });
});
