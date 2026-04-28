import { RoutingInvalidationService } from './routing-invalidation.service';
import { TierAutoAssignService } from './tier-auto-assign.service';
import { RoutingCacheService } from './routing-cache.service';
import { ModelPricingCacheService } from '../../model-prices/model-pricing-cache.service';
import { TierAssignment } from '../../entities/tier-assignment.entity';
import type { AuthType, ModelRoute } from 'manifest-shared';

function makeMockRepo() {
  return {
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn().mockImplementation((entity: unknown) => Promise.resolve(entity)),
  };
}

function route(model: string, provider = 'openai', authType: AuthType = 'api_key'): ModelRoute {
  return { provider, authType, model };
}

function makeTier(overrides: Partial<TierAssignment> = {}): TierAssignment {
  return Object.assign(new TierAssignment(), {
    id: 'tier-1',
    user_id: 'user-1',
    agent_id: 'agent-1',
    tier: 'simple',
    override_route: null,
    auto_assigned_route: route('gpt-4o-mini'),
    fallback_routes: null,
    updated_at: '2025-01-01T00:00:00Z',
    ...overrides,
  });
}

describe('RoutingInvalidationService', () => {
  let service: RoutingInvalidationService;
  let tierRepo: ReturnType<typeof makeMockRepo>;
  let pricingCache: { getByModel: jest.Mock };
  let autoAssign: { recalculate: jest.Mock };
  let routingCache: { invalidateAgent: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    tierRepo = makeMockRepo();
    pricingCache = { getByModel: jest.fn().mockReturnValue(undefined) };
    autoAssign = { recalculate: jest.fn().mockResolvedValue(undefined) };
    routingCache = { invalidateAgent: jest.fn() };

    service = new RoutingInvalidationService(
      tierRepo as unknown as any,
      pricingCache as unknown as ModelPricingCacheService,
      autoAssign as unknown as TierAutoAssignService,
      routingCache as unknown as RoutingCacheService,
    );
  });

  describe('invalidateOverridesForRemovedModels', () => {
    it('should be a no-op when removedModels is empty', async () => {
      await service.invalidateOverridesForRemovedModels([]);

      expect(tierRepo.find).not.toHaveBeenCalled();
    });

    it('should clear overrides that match removed models', async () => {
      const tier = makeTier({ override_route: route('gpt-4o'), agent_id: 'agent-1' });
      tierRepo.find.mockResolvedValueOnce([tier]);

      await service.invalidateOverridesForRemovedModels(['gpt-4o']);

      expect(tier.override_route).toBeNull();
      expect(tierRepo.save).toHaveBeenCalled();
      expect(autoAssign.recalculate).toHaveBeenCalledWith('agent-1');
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });

    it('should clean fallback models referencing removed models', async () => {
      // No overrides matched
      // Scan all tiers with fallbacks (agentIds.size === 0)
      const tierWithFallbacks = makeTier({
        agent_id: 'agent-2',
        fallback_routes: [route('gpt-4o'), route('claude-3-haiku', 'anthropic')],
      });
      tierRepo.find.mockResolvedValueOnce([tierWithFallbacks]);

      await service.invalidateOverridesForRemovedModels(['gpt-4o']);

      expect(tierWithFallbacks.fallback_routes).toEqual([route('claude-3-haiku', 'anthropic')]);
      expect(tierRepo.save).toHaveBeenCalledWith([tierWithFallbacks]);
      expect(autoAssign.recalculate).toHaveBeenCalledWith('agent-2');
    });

    it('should set fallback_routes to null when all removed', async () => {
      const tier = makeTier({ agent_id: 'agent-1', fallback_routes: [route('gpt-4o')] });
      tierRepo.find.mockResolvedValueOnce([tier]);

      await service.invalidateOverridesForRemovedModels(['gpt-4o']);

      expect(tier.fallback_routes).toBeNull();
    });

    it('should not save when no tiers are affected', async () => {
      tierRepo.find.mockResolvedValueOnce([]);

      await service.invalidateOverridesForRemovedModels(['nonexistent-model']);

      expect(tierRepo.save).not.toHaveBeenCalled();
      expect(autoAssign.recalculate).not.toHaveBeenCalled();
    });

    it('should handle multiple agents affected', async () => {
      const tier1 = makeTier({
        id: 't1',
        agent_id: 'agent-1',
        override_route: route('gpt-4o'),
      });
      const tier2 = makeTier({
        id: 't2',
        agent_id: 'agent-2',
        override_route: route('gpt-4o'),
      });
      tierRepo.find.mockResolvedValueOnce([tier1, tier2]);

      await service.invalidateOverridesForRemovedModels(['gpt-4o']);

      expect(autoAssign.recalculate).toHaveBeenCalledTimes(2);
      expect(routingCache.invalidateAgent).toHaveBeenCalledTimes(2);
    });

    it('should not duplicate tier in save when override and fallback both match', async () => {
      const tier = makeTier({
        id: 'shared-tier',
        agent_id: 'agent-1',
        override_route: route('gpt-4o'),
        fallback_routes: [route('gpt-4o-mini')],
      });
      tierRepo.find.mockResolvedValueOnce([tier]);

      await service.invalidateOverridesForRemovedModels(['gpt-4o', 'gpt-4o-mini']);

      const savedEntities = tierRepo.save.mock.calls[0][0] as TierAssignment[];
      expect(savedEntities.filter((t: TierAssignment) => t.id === 'shared-tier')).toHaveLength(1);
    });

    it('should skip fallback tiers with no fallback_models', async () => {
      const tierNoFallbacks = makeTier({ fallback_routes: null });
      tierRepo.find.mockResolvedValueOnce([tierNoFallbacks]);

      await service.invalidateOverridesForRemovedModels(['gpt-4o']);

      expect(tierRepo.save).not.toHaveBeenCalled();
    });

    it('should skip fallback tiers with empty fallback_models array', async () => {
      const tierEmptyFallbacks = makeTier({ fallback_routes: [] });
      tierRepo.find.mockResolvedValueOnce([tierEmptyFallbacks]);

      await service.invalidateOverridesForRemovedModels(['gpt-4o']);

      expect(tierRepo.save).not.toHaveBeenCalled();
    });

    it('should read all tiers once to evaluate route json in TypeScript', async () => {
      const overrideTier = makeTier({
        agent_id: 'agent-1',
        override_route: route('gpt-4o'),
      });
      tierRepo.find.mockResolvedValueOnce([overrideTier]);

      await service.invalidateOverridesForRemovedModels(['gpt-4o']);

      expect(tierRepo.find).toHaveBeenCalledTimes(1);
      expect(tierRepo.find).toHaveBeenCalledWith();
    });
  });
});
