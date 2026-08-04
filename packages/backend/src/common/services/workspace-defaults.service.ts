import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tenant } from '../../entities/tenant.entity';
import { TtlFifoCache } from '../utils/ttl-fifo-cache';

/** Workspace-level defaults for per-agent settings, set in Account Preferences. */
export interface WorkspaceDefaults {
  /** NULL/undefined = no workspace choice; the deployment default applies. */
  autofix: boolean | null;
  /** NULL/undefined = no workspace choice; recording falls back to ON. */
  recording: boolean | null;
}

const NO_DEFAULTS: WorkspaceDefaults = { autofix: null, recording: null };

/**
 * Reads (and caches) the per-tenant agent defaults.
 *
 * Every consumer sits on a hot path — the Auto-fix failure path and the
 * recording check both run per request — so the lookup is cached with the same
 * short TTL the per-agent caches use, and invalidated when the Account
 * Preferences toggles write.
 *
 * An unknown tenant resolves to "no workspace choice" rather than throwing:
 * a default is an optional refinement, and a missing tenant row must never turn
 * into a failure on the request path.
 */
@Injectable()
export class WorkspaceDefaultsService {
  private readonly cache = new TtlFifoCache<string, WorkspaceDefaults>({
    maxEntries: 5_000,
    ttlMs: 30_000,
  });

  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
  ) {}

  async get(tenantId: string | null | undefined): Promise<WorkspaceDefaults> {
    if (!tenantId) return NO_DEFAULTS;
    return this.cache.resolve(tenantId, async (id) => {
      const tenant = await this.tenantRepo.findOne({
        where: { id },
        // Select the PK alongside the flags: TypeORM treats a row whose only
        // selected columns are all NULL as "no entity" and returns null, which
        // would make an unset workspace look identical to a missing tenant.
        select: ['id', 'autofix_default_enabled', 'recording_default_enabled'],
      });
      if (!tenant) return NO_DEFAULTS;
      return {
        autofix: tenant.autofix_default_enabled ?? null,
        recording: tenant.recording_default_enabled ?? null,
      };
    });
  }

  invalidate(tenantId: string): void {
    this.cache.invalidate(tenantId);
  }
}
