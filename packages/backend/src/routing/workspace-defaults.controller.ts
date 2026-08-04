import { Body, Controller, Get, Patch } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsBoolean, IsOptional } from 'class-validator';
import { Repository } from 'typeorm';
import { TenantCtx, TenantContext } from '../common/decorators/tenant-context.decorator';
import { Tenant } from '../entities/tenant.entity';
import { WorkspaceDefaultsService } from '../common/services/workspace-defaults.service';

export class UpdateWorkspaceDefaultsDto {
  /** Omitted = leave unchanged. `null` = clear the workspace choice. */
  @IsOptional()
  @IsBoolean()
  autofix?: boolean | null;

  @IsOptional()
  @IsBoolean()
  recording?: boolean | null;
}

/**
 * Workspace-wide defaults for per-agent settings, surfaced in Account
 * Preferences. These seed agents that have made no choice of their own; an
 * agent's own toggle always wins, so writing here never overrides anyone.
 */
@Controller('api/v1/workspace')
export class WorkspaceDefaultsController {
  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    private readonly workspaceDefaults: WorkspaceDefaultsService,
  ) {}

  @Get('defaults')
  async get(@TenantCtx() ctx: TenantContext) {
    return this.workspaceDefaults.get(ctx.tenantId);
  }

  @Patch('defaults')
  async update(@TenantCtx() ctx: TenantContext, @Body() body: UpdateWorkspaceDefaultsDto) {
    // `null` is a meaningful value here (clear the choice), so presence — not
    // truthiness — decides what gets written. An absent key leaves the column
    // alone rather than resetting it.
    const patch: Partial<Tenant> = {};
    if ('autofix' in body) patch.autofix_default_enabled = body.autofix ?? null;
    if ('recording' in body) patch.recording_default_enabled = body.recording ?? null;

    // No tenant resolved → nothing to store the choice against. Fall through to
    // the read, which reports "no workspace choice", rather than 500ing.
    const tenantId = ctx.tenantId;
    if (tenantId && Object.keys(patch).length > 0) {
      await this.tenantRepo.update(tenantId, patch);
      this.workspaceDefaults.invalidate(tenantId);
    }
    return this.workspaceDefaults.get(tenantId);
  }
}
