import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { UserProvider } from '../../entities/user-provider.entity';
import { TierAssignment } from '../../entities/tier-assignment.entity';
import { SpecificityAssignment } from '../../entities/specificity-assignment.entity';
import { ModelPricingCacheService } from '../../model-prices/model-pricing-cache.service';
import { TierAutoAssignService } from './tier-auto-assign.service';
import { RoutingCacheService } from './routing-cache.service';
import { randomUUID } from 'crypto';
import { encrypt, decrypt, getEncryptionSecret } from '../../common/utils/crypto.util';
import {
  isManifestUsableProvider,
  isSupportedSubscriptionProvider,
} from '../../common/utils/subscription-support';
import { TIER_LABELS, type AuthType, type ModelRoute } from 'manifest-shared';
import { detectQwenRegion, isQwenRegion, isQwenResolvedRegion } from '../qwen-region';

interface ProviderRouteReference {
  provider: string;
  authType?: AuthType;
}

@Injectable()
export class ProviderService {
  private readonly logger = new Logger(ProviderService.name);

  constructor(
    @InjectRepository(UserProvider)
    private readonly providerRepo: Repository<UserProvider>,
    @InjectRepository(TierAssignment)
    private readonly tierRepo: Repository<TierAssignment>,
    @InjectRepository(SpecificityAssignment)
    private readonly specificityRepo: Repository<SpecificityAssignment>,
    private readonly autoAssign: TierAutoAssignService,
    private readonly pricingCache: ModelPricingCacheService,
    private readonly routingCache: RoutingCacheService,
  ) {}

  /** Public entry point for tier recalculation (e.g. after model discovery). */
  async recalculateTiers(agentId: string): Promise<void> {
    await this.autoAssign.recalculate(agentId);
    this.routingCache.invalidateAgent(agentId);
  }

  async getProviders(agentId: string): Promise<UserProvider[]> {
    const cached = this.routingCache.getProviders(agentId);
    if (cached) return cached;

    await this.cleanupUnsupportedSubscriptionProviders(agentId);
    const providers = (await this.providerRepo.find({ where: { agent_id: agentId } })).filter(
      isManifestUsableProvider,
    );
    this.routingCache.setProviders(agentId, providers);
    return providers;
  }

  async upsertProvider(
    agentId: string,
    userId: string,
    provider: string,
    apiKey?: string,
    authType?: AuthType,
    region?: string,
  ): Promise<{ provider: UserProvider; isNew: boolean }> {
    const effectiveAuthType = authType ?? 'api_key';
    const existing = await this.providerRepo.findOne({
      where: { agent_id: agentId, provider, auth_type: effectiveAuthType },
    });
    const resolvedRegion = await this.resolveProviderRegion(
      provider,
      effectiveAuthType,
      region,
      apiKey,
      existing,
    );
    const apiKeyEncrypted = apiKey ? encrypt(apiKey, getEncryptionSecret()) : null;
    const keyPrefix = apiKey ? apiKey.substring(0, 8) : null;

    if (existing) {
      if (apiKeyEncrypted !== null) {
        existing.api_key_encrypted = apiKeyEncrypted;
        existing.key_prefix = keyPrefix;
      }
      existing.region = resolvedRegion;
      existing.is_active = true;
      existing.updated_at = new Date().toISOString();
      await this.providerRepo.save(existing);
      await this.afterProviderInsert(agentId);
      return { provider: existing, isNew: false };
    }

    const record: UserProvider = Object.assign(new UserProvider(), {
      id: randomUUID(),
      user_id: userId,
      agent_id: agentId,
      provider,
      auth_type: effectiveAuthType,
      api_key_encrypted: apiKeyEncrypted,
      key_prefix: keyPrefix,
      region: resolvedRegion,
      is_active: true,
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    await this.providerRepo.insert(record);
    await this.afterProviderInsert(agentId);
    return { provider: record, isNew: true };
  }

  private async resolveProviderRegion(
    provider: string,
    authType: AuthType,
    requestedRegion: string | undefined,
    apiKey: string | undefined,
    existing: UserProvider | null,
  ): Promise<string | null> {
    const lower = provider.toLowerCase();
    const isQwenProvider = lower === 'qwen' || lower === 'alibaba';
    if (!isQwenProvider || authType !== 'api_key') return null;

    if (requestedRegion === undefined) {
      if (apiKey) {
        return this.detectQwenRegionOrThrow(apiKey);
      }
      return isQwenResolvedRegion(existing?.region) ? existing.region : null;
    }

    if (!isQwenRegion(requestedRegion)) {
      throw new BadRequestException('Qwen region must be one of: auto, singapore, us, beijing');
    }

    if (requestedRegion !== 'auto') return requestedRegion;

    const keyToProbe = await this.getQwenDetectionKey(apiKey, existing);
    if (!keyToProbe) {
      return isQwenResolvedRegion(existing?.region) ? existing.region : null;
    }

    return this.detectQwenRegionOrThrow(keyToProbe);
  }

  private async getQwenDetectionKey(
    apiKey: string | undefined,
    existing: UserProvider | null,
  ): Promise<string | null> {
    if (apiKey) return apiKey;
    if (!existing?.api_key_encrypted) return null;

    try {
      return decrypt(existing.api_key_encrypted, getEncryptionSecret());
    } catch {
      this.logger.warn('Failed to decrypt API key while auto-detecting Alibaba region');
      return null;
    }
  }

  private async detectQwenRegionOrThrow(apiKey: string): Promise<string> {
    const detected = await detectQwenRegion(apiKey);
    if (detected) return detected;

    throw new BadRequestException(
      'Could not auto-detect Alibaba region from this API key. Verify the key and try again.',
    );
  }

  async registerSubscriptionProvider(
    agentId: string,
    userId: string,
    provider: string,
  ): Promise<{ isNew: boolean }> {
    if (!isSupportedSubscriptionProvider(provider)) {
      this.logger.debug(`Ignoring unsupported subscription provider registration for ${provider}`);
      return { isNew: false };
    }

    const existing = await this.providerRepo.findOne({
      where: { agent_id: agentId, provider, auth_type: 'subscription' },
    });

    if (existing) return { isNew: false };
    const hasApiKey = await this.providerRepo.findOne({
      where: { agent_id: agentId, provider, auth_type: 'api_key', is_active: true },
    });
    if (hasApiKey) return { isNew: false };

    const record: UserProvider = Object.assign(new UserProvider(), {
      id: randomUUID(),
      user_id: userId,
      agent_id: agentId,
      provider,
      auth_type: 'subscription',
      api_key_encrypted: null,
      key_prefix: null,
      is_active: true,
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    await this.providerRepo.insert(record);
    await this.afterProviderInsert(agentId);
    return { isNew: true };
  }

  private async afterProviderInsert(agentId: string): Promise<void> {
    await this.autoAssign.recalculate(agentId);
    this.routingCache.invalidateAgent(agentId);
  }

  /**
   * Flip `auth_type` on an existing `user_providers` row in-place without
   * deactivating it or cleaning up tier overrides. Used by custom-provider
   * renames that cross the local ↔ api_key boundary (LM Studio ↔ freeform
   * name), where going through removeProvider+upsertProvider would churn
   * tier assignments for what is visually just a name change.
   */
  async retagAuthType(agentId: string, provider: string, nextAuthType: AuthType): Promise<void> {
    // Wrap the dedupe + flip in a transaction so a crash between the
    // collision DELETE and the retag SAVE can't leave the row set in a
    // half-updated state (losing the collision row while the source still
    // carries the old auth_type).
    const invalidated = await this.providerRepo.manager.transaction(async (manager) => {
      const txRepo = manager.getRepository(UserProvider);
      const rows = await txRepo.find({ where: { agent_id: agentId, provider } });
      const target = rows.find((r) => r.auth_type !== nextAuthType && r.is_active);
      if (!target) return false;

      // Protect the unique (agent_id, provider, auth_type) index: if a row
      // already exists for the destination auth_type, the UPDATE would fail.
      // Drop the stale destination row first — the one we're retagging is
      // authoritative.
      const collision = rows.find((r) => r.auth_type === nextAuthType);
      if (collision) {
        await txRepo.remove(collision);
      }

      target.auth_type = nextAuthType;
      target.updated_at = new Date().toISOString();
      await txRepo.save(target);
      return true;
    });

    if (invalidated) this.routingCache.invalidateAgent(agentId);
  }

  async removeProvider(
    agentId: string,
    provider: string,
    authType?: AuthType,
  ): Promise<{ notifications: string[] }> {
    const where: Record<string, unknown> = { agent_id: agentId, provider };
    if (authType) where.auth_type = authType;

    const existing = await this.providerRepo.findOne({ where });
    if (!existing) throw new NotFoundException('Provider not found');

    // Deactivate this record
    existing.is_active = false;
    existing.updated_at = new Date().toISOString();
    await this.providerRepo.save(existing);

    const { invalidated } = await this.cleanupProviderReferences(agentId, [{ provider, authType }]);
    await this.autoAssign.recalculate(agentId);
    this.routingCache.invalidateAgent(agentId);

    const notifications: string[] = [];
    if (invalidated.length > 0) {
      const tierNames = invalidated.map((i) => i.tier);
      const updatedTiers = await this.tierRepo.find({
        where: { agent_id: agentId, tier: In(tierNames) },
      });
      const tierMap = new Map(updatedTiers.map((t) => [t.tier, t]));
      for (const { tier, modelName } of invalidated) {
        const updated = tierMap.get(tier);
        const newModel = updated?.auto_assigned_route?.model ?? null;
        const tierLabel = TIER_LABELS[tier as keyof typeof TIER_LABELS] ?? tier;
        const suffix = newModel
          ? `${tierLabel} is back to automatic mode (${newModel}).`
          : `${tierLabel} is back to automatic mode.`;
        notifications.push(`${modelName} is no longer available. ${suffix}`);
      }
    }

    return { notifications };
  }
  async deactivateAllProviders(agentId: string): Promise<void> {
    await this.providerRepo.update(
      { agent_id: agentId },
      { is_active: false, updated_at: new Date().toISOString() },
    );
    await this.tierRepo.update(
      { agent_id: agentId },
      {
        override_route: null,
        fallback_routes: null,
        updated_at: new Date().toISOString(),
      },
    );
    await this.autoAssign.recalculate(agentId);
    this.routingCache.invalidateAgent(agentId);
  }
  private async cleanupUnsupportedSubscriptionProviders(agentId: string): Promise<void> {
    const activeProviders = await this.providerRepo.find({
      where: { agent_id: agentId, is_active: true },
    });
    const unsupported = activeProviders.filter(
      (record) => record.auth_type === 'subscription' && !isManifestUsableProvider(record),
    );
    if (unsupported.length === 0) return;

    const now = new Date().toISOString();
    for (const record of unsupported) {
      record.is_active = false;
      record.updated_at = now;
    }
    await this.providerRepo.save(unsupported);

    const removedReferences = Array.from(
      new Map(
        unsupported.map((record) => [
          `${record.provider.toLowerCase()}:${record.auth_type}`,
          { provider: record.provider, authType: record.auth_type },
        ]),
      ).values(),
    );

    if (removedReferences.length > 0) {
      const { hadTierAssignments } = await this.cleanupProviderReferences(
        agentId,
        removedReferences,
      );
      if (hadTierAssignments) {
        await this.autoAssign.recalculate(agentId);
      }
    }
    this.routingCache.invalidateAgent(agentId);
  }

  /**
   * Clears route-shaped overrides and fallback entries on tier_assignments
   * and specificity_assignments that point at any of the given provider/auth
   * references. When an auth type is provided, only that route identity is
   * removed so routes for another auth method on the same provider survive.
   * The model name is reported back so the caller can surface
   * "X is no longer available" notifications.
   */
  private async cleanupProviderReferences(
    agentId: string,
    references: ProviderRouteReference[],
  ): Promise<{ invalidated: { tier: string; modelName: string }[]; hadTierAssignments: boolean }> {
    if (references.length === 0) return { invalidated: [], hadTierAssignments: false };

    const normalizedReferences = references.map((reference) => ({
      provider: reference.provider.toLowerCase(),
      authType: reference.authType,
    }));
    const matches = (route: ModelRoute): boolean =>
      normalizedReferences.some(
        (reference) =>
          route.provider.toLowerCase() === reference.provider &&
          (!reference.authType || route.authType === reference.authType),
      );

    const invalidated: { tier: string; modelName: string }[] = [];

    const allTiers = await this.tierRepo.find({ where: { agent_id: agentId } });
    const hadTierAssignments = allTiers.length > 0;
    const tiersToSave: TierAssignment[] = [];
    for (const tier of allTiers) {
      let mutated = false;
      if (tier.override_route && matches(tier.override_route)) {
        invalidated.push({ tier: tier.tier, modelName: tier.override_route.model });
        tier.override_route = null;
        mutated = true;
      }
      if (tier.fallback_routes && tier.fallback_routes.length > 0) {
        const filtered = tier.fallback_routes.filter((r) => !matches(r));
        if (filtered.length !== tier.fallback_routes.length) {
          tier.fallback_routes = filtered.length > 0 ? filtered : null;
          mutated = true;
        }
      }
      if (mutated) {
        tier.updated_at = new Date().toISOString();
        tiersToSave.push(tier);
      }
    }
    if (tiersToSave.length > 0) await this.tierRepo.save(tiersToSave);

    const specRows = await this.specificityRepo.find({ where: { agent_id: agentId } });
    const specToSave: SpecificityAssignment[] = [];
    for (const row of specRows) {
      let mutated = false;
      if (row.override_route && matches(row.override_route)) {
        row.override_route = null;
        mutated = true;
      }
      if (row.fallback_routes && row.fallback_routes.length > 0) {
        const filtered = row.fallback_routes.filter((r) => !matches(r));
        if (filtered.length !== row.fallback_routes.length) {
          row.fallback_routes = filtered.length > 0 ? filtered : null;
          mutated = true;
        }
      }
      if (mutated) {
        row.updated_at = new Date().toISOString();
        specToSave.push(row);
      }
    }
    if (specToSave.length > 0) await this.specificityRepo.save(specToSave);

    return { invalidated, hadTierAssignments };
  }
}
