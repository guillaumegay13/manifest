import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Agent } from '../../entities/agent.entity';
import { TtlFifoCache } from '../utils/ttl-fifo-cache';
import { WorkspaceDefaultsService } from './workspace-defaults.service';

/** Fallback when neither the agent nor its workspace has made a choice. */
export const RECORDING_FALLBACK_ENABLED = true;

interface CachedAgentRecording {
  /** NULL = no explicit agent choice; inherit the workspace default. */
  flag: boolean | null;
  tenantId: string;
}

@Injectable()
export class AgentRecordingCacheService {
  // Caches the *stored* flag rather than the resolved answer, so flipping the
  // workspace default takes effect as soon as the workspace cache turns over
  // instead of waiting out every per-agent entry.
  private readonly cache = new TtlFifoCache<string, CachedAgentRecording | null>({
    maxEntries: 5_000,
    ttlMs: 60_000,
  });

  constructor(
    @InjectRepository(Agent)
    private readonly agentRepo: Repository<Agent>,
    private readonly workspaceDefaults: WorkspaceDefaultsService,
  ) {}

  async isRecording(agentId: string | null | undefined): Promise<boolean> {
    if (!agentId) return false;
    const cached = await this.cache.resolve(agentId, async (id) => {
      const agent = await this.agentRepo.findOne({
        where: { id },
        select: ['id', 'record_messages', 'tenant_id'],
      });
      if (!agent) return null;
      return { flag: agent.record_messages ?? null, tenantId: agent.tenant_id };
    });
    // Unknown agent → not recording.
    if (!cached) return false;
    if (typeof cached.flag === 'boolean') return cached.flag;
    const defaults = await this.workspaceDefaults.get(cached.tenantId);
    return defaults.recording ?? RECORDING_FALLBACK_ENABLED;
  }

  invalidate(agentId: string): void {
    this.cache.invalidate(agentId);
  }
}
