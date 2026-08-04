import { Entity, Column, PrimaryColumn, OneToMany } from 'typeorm';
import { Agent } from './agent.entity';
import { timestampType, timestampDefault } from '../common/utils/postgres-sql';
import type { BillingEmailPreferences } from 'manifest-shared';

@Entity('tenants')
export class Tenant {
  @PrimaryColumn('varchar')
  id!: string;

  @Column('varchar', { unique: true })
  name!: string;

  /**
   * The Better Auth user that owns this tenant (1:1 today). This is the ONLY
   * sanctioned user→tenant link — resolution goes through
   * TenantCacheService.resolve(). Nullable: future tenants may exist without
   * a single owning user. The partial unique index lives in the
   * TenantOwnerColumn migration (unique only where NOT NULL, which a plain
   * @Index can't express).
   */
  @Column('varchar', { nullable: true })
  owner_user_id!: string | null;

  @Column('varchar', { nullable: true })
  organization_name!: string | null;

  @Column('varchar', { nullable: true })
  email!: string | null;

  @Column('boolean', { default: true })
  is_active!: boolean;

  /**
   * Per-tenant plan-limit overrides (support / enterprise escape hatch).
   * Null = plan defaults apply. When set, the matching fields override the
   * resolved plan limits. Read by PlanService.getLimits().
   */
  @Column('jsonb', { nullable: true })
  limit_overrides!: { requestsPerMonth?: number } | null;

  @Column('jsonb', { nullable: true })
  billing_email_preferences!: Partial<BillingEmailPreferences> | null;

  /**
   * Workspace default for Auto-fix, set in Account Preferences. NULL means "no
   * workspace choice", so agents fall through to the deployment default
   * (`AUTOFIX_DEFAULT_ENABLED`, else ON in cloud / OFF in self-hosted). An
   * agent's own `autofix_enabled` always outranks this.
   */
  @Column('boolean', { nullable: true })
  autofix_default_enabled!: boolean | null;

  /**
   * Workspace default for request recording, set in Account Preferences. NULL
   * means "no workspace choice" and recording falls back to ON. An agent's own
   * `record_messages` always outranks this.
   */
  @Column('boolean', { nullable: true })
  recording_default_enabled!: boolean | null;

  @OneToMany(() => Agent, (a) => a.tenant, { cascade: true })
  agents!: Agent[];

  @Column(timestampType(), { default: timestampDefault() })
  created_at!: string;

  @Column(timestampType(), { default: timestampDefault() })
  updated_at!: string;
}
