import { BadRequestException } from '@nestjs/common';
import { TierService } from './tier.service';
import { TierAutoAssignService } from './tier-auto-assign.service';
import { RoutingCacheService } from './routing-cache.service';
import { ProviderService } from './provider.service';
import { ModelDiscoveryService } from '../../model-discovery/model-discovery.service';
import { DiscoveredModel } from '../../model-discovery/model-fetcher';
import { TierAssignment } from '../../entities/tier-assignment.entity';
import { UserProvider } from '../../entities/user-provider.entity';
import type { AuthType, ModelRoute } from 'manifest-shared';

function makeDiscoveredModel(overrides: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    id: 'gpt-4o',
    displayName: 'GPT-4o',
    provider: 'openai',
    authType: 'api_key',
    contextWindow: 128000,
    inputPricePerToken: 0.000005,
    outputPricePerToken: 0.000015,
    capabilityReasoning: false,
    capabilityCode: true,
    qualityScore: 4,
    ...overrides,
  } as DiscoveredModel;
}

jest.mock('../../common/utils/subscription-support', () => ({
  isManifestUsableProvider: jest.fn((record: { auth_type?: string }) => {
    return record.auth_type !== 'subscription';
  }),
}));

function makeMockRepo() {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockImplementation((entity: unknown) => Promise.resolve(entity)),
    insert: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
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

describe('TierService', () => {
  let service: TierService;
  let providerRepo: ReturnType<typeof makeMockRepo>;
  let tierRepo: ReturnType<typeof makeMockRepo>;
  let autoAssign: { recalculate: jest.Mock };
  let routingCache: {
    getTiers: jest.Mock;
    setTiers: jest.Mock;
    invalidateAgent: jest.Mock;
    getProviders: jest.Mock;
    setProviders: jest.Mock;
  };
  let providerService: { getProviders: jest.Mock };
  let discoveryService: { getModelsForAgent: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    providerRepo = makeMockRepo();
    tierRepo = makeMockRepo();
    autoAssign = { recalculate: jest.fn().mockResolvedValue(undefined) };
    routingCache = {
      getTiers: jest.fn().mockReturnValue(null),
      setTiers: jest.fn(),
      invalidateAgent: jest.fn(),
      getProviders: jest.fn().mockReturnValue(null),
      setProviders: jest.fn(),
    };
    providerService = { getProviders: jest.fn().mockResolvedValue([]) };
    discoveryService = {
      getModelsForAgent: jest
        .fn()
        .mockResolvedValue([
          makeDiscoveredModel({ id: 'gpt-4o', provider: 'openai' }),
          makeDiscoveredModel({ id: 'claude-3-haiku', provider: 'anthropic' }),
        ]),
    };

    service = new TierService(
      providerRepo as unknown as any,
      tierRepo as unknown as any,
      autoAssign as unknown as TierAutoAssignService,
      routingCache as unknown as RoutingCacheService,
      providerService as unknown as ProviderService,
      discoveryService as unknown as ModelDiscoveryService,
    );
  });

  /* ── hasRoutableTier ── */

  describe('hasRoutableTier', () => {
    it('returns true when a tier has an auto_assigned_route', async () => {
      tierRepo.find.mockResolvedValue([makeTier({ auto_assigned_route: route('gpt-4o') })]);

      const result = await service.hasRoutableTier('agent-1');
      expect(result).toBe(true);
    });

    it('returns true when a tier has an override_route', async () => {
      tierRepo.find.mockResolvedValue([
        makeTier({ auto_assigned_route: null, override_route: route('claude-sonnet') }),
      ]);

      const result = await service.hasRoutableTier('agent-1');
      expect(result).toBe(true);
    });

    it('returns false when all tier rows are null', async () => {
      tierRepo.find.mockResolvedValue([
        makeTier({ auto_assigned_route: null, override_route: null }),
        makeTier({
          id: 'tier-2',
          tier: 'complex',
          auto_assigned_route: null,
          override_route: null,
        }),
      ]);

      const result = await service.hasRoutableTier('agent-1');
      expect(result).toBe(false);
    });

    it('returns false when no tier rows exist', async () => {
      tierRepo.find.mockResolvedValue([]);

      const result = await service.hasRoutableTier('agent-1');
      expect(result).toBe(false);
    });
  });

  /* ── getTiers ── */

  describe('getTiers', () => {
    it('should return cached tiers when available', async () => {
      const cached = [makeTier()];
      routingCache.getTiers.mockReturnValue(cached);

      const result = await service.getTiers('agent-1');

      expect(result).toBe(cached);
      expect(tierRepo.find).not.toHaveBeenCalled();
    });

    it('should fetch and cache existing tiers from DB', async () => {
      const tiers = [
        makeTier({ tier: 'simple' }),
        makeTier({ id: 'tier-2', tier: 'standard' }),
        makeTier({ id: 'tier-3', tier: 'complex' }),
        makeTier({ id: 'tier-4', tier: 'reasoning' }),
        makeTier({ id: 'tier-5', tier: 'default' }),
      ];
      tierRepo.find.mockResolvedValue(tiers);

      const result = await service.getTiers('agent-1');

      expect(result).toEqual(tiers);
      expect(routingCache.setTiers).toHaveBeenCalledWith('agent-1', tiers);
      expect(tierRepo.insert).not.toHaveBeenCalled();
    });

    it('should create all 5 tier slots when none exist', async () => {
      tierRepo.find.mockResolvedValue([]);

      const result = await service.getTiers('agent-1', 'user-1');

      expect(tierRepo.insert).toHaveBeenCalled();
      const inserted = tierRepo.insert.mock.calls[0][0] as TierAssignment[];
      expect(inserted).toHaveLength(5);
      expect(inserted.map((t: TierAssignment) => t.tier)).toEqual(
        expect.arrayContaining(['simple', 'standard', 'complex', 'reasoning', 'default']),
      );
      expect(result).toHaveLength(5);
      expect(routingCache.setTiers).toHaveBeenCalledWith('agent-1', inserted);
    });

    it('fills in missing slots when some rows already exist (e.g. after migration)', async () => {
      const partial = [makeTier({ tier: 'simple' }), makeTier({ id: 'tier-2', tier: 'standard' })];
      tierRepo.find.mockResolvedValue(partial);

      const result = await service.getTiers('agent-1', 'user-1');

      expect(tierRepo.insert).toHaveBeenCalled();
      const inserted = tierRepo.insert.mock.calls[0][0] as TierAssignment[];
      expect(inserted.map((t: TierAssignment) => t.tier).sort()).toEqual([
        'complex',
        'default',
        'reasoning',
      ]);
      expect(result).toHaveLength(5);
    });

    it('re-reads and returns existing rows when insert fails from a concurrent write', async () => {
      tierRepo.find.mockResolvedValueOnce([]);
      tierRepo.insert.mockRejectedValueOnce(new Error('unique violation'));
      const racedTiers = [
        makeTier({ tier: 'simple' }),
        makeTier({ id: 'tier-2', tier: 'standard' }),
        makeTier({ id: 'tier-3', tier: 'complex' }),
        makeTier({ id: 'tier-4', tier: 'reasoning' }),
        makeTier({ id: 'tier-5', tier: 'default' }),
      ];
      tierRepo.find.mockResolvedValueOnce(racedTiers);

      const result = await service.getTiers('agent-1', 'user-1');

      expect(result).toEqual(racedTiers);
      expect(routingCache.setTiers).toHaveBeenCalledWith('agent-1', racedTiers);
    });

    it('rethrows insert failures when the re-read confirms no rows landed', async () => {
      tierRepo.find.mockResolvedValueOnce([]); // initial read
      const insertErr = new Error('FK violation');
      tierRepo.insert.mockRejectedValueOnce(insertErr);
      tierRepo.find.mockResolvedValueOnce([]); // re-read after failure: still empty

      await expect(service.getTiers('agent-1', 'user-1')).rejects.toThrow('FK violation');
    });

    it('should use empty string for user_id when not provided', async () => {
      tierRepo.find.mockResolvedValue([]);

      await service.getTiers('agent-1');

      const inserted = tierRepo.insert.mock.calls[0][0] as TierAssignment[];
      expect(inserted[0].user_id).toBe('');
    });

    it('should recalculate immediately when agent has active usable providers', async () => {
      tierRepo.find.mockResolvedValueOnce([]); // Initial: no tiers
      providerRepo.find.mockResolvedValue([
        { id: 'p1', agent_id: 'agent-1', is_active: true, auth_type: 'api_key' } as UserProvider,
      ]);
      // After recalculate, re-fetch returns populated tiers
      const populatedTiers = [makeTier({ auto_assigned_route: route('gpt-4o') })];
      tierRepo.find.mockResolvedValueOnce(populatedTiers);

      const result = await service.getTiers('agent-1', 'user-1');

      expect(autoAssign.recalculate).toHaveBeenCalledWith('agent-1');
      expect(result).toEqual(populatedTiers);
    });

    it('should not recalculate when active providers are all subscription-only', async () => {
      tierRepo.find.mockResolvedValue([]);
      providerRepo.find.mockResolvedValue([
        {
          id: 'p1',
          agent_id: 'agent-1',
          is_active: true,
          auth_type: 'subscription',
        } as UserProvider,
      ]);

      await service.getTiers('agent-1', 'user-1');

      expect(autoAssign.recalculate).not.toHaveBeenCalled();
    });

    it('should trigger provider cleanup via getProviders', async () => {
      tierRepo.find.mockResolvedValue([makeTier()]);

      await service.getTiers('agent-1');

      expect(providerService.getProviders).toHaveBeenCalledWith('agent-1');
    });
  });

  /* ── setOverride ── */

  describe('setOverride', () => {
    it('should update existing tier assignment', async () => {
      const existing = makeTier();
      tierRepo.findOne.mockResolvedValue(existing);
      const overrideRoute = route('gpt-4o');

      const result = await service.setOverride('agent-1', 'user-1', 'simple', overrideRoute);

      expect(result.override_route).toEqual(overrideRoute);
      expect(tierRepo.save).toHaveBeenCalledWith(existing);
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });

    it('should remove model from fallback list when setting as override', async () => {
      const existing = makeTier({
        fallback_routes: [route('gpt-4o'), route('claude-3-haiku', 'anthropic')],
      });
      tierRepo.findOne.mockResolvedValue(existing);

      await service.setOverride('agent-1', 'user-1', 'simple', route('gpt-4o'));

      expect(existing.fallback_routes).toEqual([route('claude-3-haiku', 'anthropic')]);
    });

    it('should set fallback_routes to null when removing last fallback', async () => {
      const existing = makeTier({ fallback_routes: [route('gpt-4o')] });
      tierRepo.findOne.mockResolvedValue(existing);

      await service.setOverride('agent-1', 'user-1', 'simple', route('gpt-4o'));

      expect(existing.fallback_routes).toBeNull();
    });

    it('should not modify fallback_routes when override route not in list', async () => {
      const fallback = route('claude-3-haiku', 'anthropic');
      const existing = makeTier({ fallback_routes: [fallback] });
      tierRepo.findOne.mockResolvedValue(existing);

      await service.setOverride('agent-1', 'user-1', 'simple', route('gpt-4o'));

      expect(existing.fallback_routes).toEqual([fallback]);
    });

    it('should create new tier assignment when not existing', async () => {
      tierRepo.findOne.mockResolvedValue(null);
      const overrideRoute = route('gpt-4o');

      const result = await service.setOverride('agent-1', 'user-1', 'complex', overrideRoute);

      expect(tierRepo.insert).toHaveBeenCalled();
      expect(result.tier).toBe('complex');
      expect(result.override_route).toEqual(overrideRoute);
      expect(result.auto_assigned_route).toBeNull();
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });

    it('should preserve provider and authType from the route', async () => {
      tierRepo.findOne.mockResolvedValue(null);
      const overrideRoute = route('gpt-4o', 'openai', 'api_key');

      const result = await service.setOverride('agent-1', 'user-1', 'simple', overrideRoute);

      expect(result.override_route).toEqual(overrideRoute);
    });

    it('should not touch fallback_routes when null on existing tier', async () => {
      const existing = makeTier({ fallback_routes: null });
      tierRepo.findOne.mockResolvedValue(existing);

      await service.setOverride('agent-1', 'user-1', 'simple', route('gpt-4o'));

      expect(existing.fallback_routes).toBeNull();
    });

    it('should reject unknown model with BadRequestException', async () => {
      await expect(
        service.setOverride('agent-1', 'user-1', 'simple', route('gpt-does-not-exist')),
      ).rejects.toThrow(BadRequestException);
      expect(tierRepo.save).not.toHaveBeenCalled();
      expect(tierRepo.insert).not.toHaveBeenCalled();
    });

    it('should include available models in the rejection message', async () => {
      await expect(
        service.setOverride('agent-1', 'user-1', 'simple', route('bogus-model')),
      ).rejects.toThrow(/gpt-4o/);
    });

    it('should reject model when provider hint does not match the discovered entry', async () => {
      await expect(
        service.setOverride('agent-1', 'user-1', 'simple', route('gpt-4o', 'anthropic')),
      ).rejects.toThrow(BadRequestException);
      expect(tierRepo.save).not.toHaveBeenCalled();
    });

    it('should accept model when provider hint matches', async () => {
      const existing = makeTier();
      tierRepo.findOne.mockResolvedValue(existing);

      await service.setOverride('agent-1', 'user-1', 'simple', route('gpt-4o', 'openai'));

      expect(tierRepo.save).toHaveBeenCalled();
    });

    it('should accept model when provider hint matches case-insensitively', async () => {
      const existing = makeTier();
      tierRepo.findOne.mockResolvedValue(existing);

      await service.setOverride('agent-1', 'user-1', 'simple', route('gpt-4o', 'OpenAI'));

      expect(tierRepo.save).toHaveBeenCalled();
    });

    it('should truncate options list when many models are available', async () => {
      const many = Array.from({ length: 30 }, (_, i) =>
        makeDiscoveredModel({ id: `model-${i}`, provider: 'openai' }),
      );
      discoveryService.getModelsForAgent.mockResolvedValue(many);

      await expect(
        service.setOverride('agent-1', 'user-1', 'simple', route('missing-model')),
      ).rejects.toThrow(/\.\.\./);
    });
  });

  /* ── clearOverride ── */

  describe('clearOverride', () => {
    it('should clear override fields on existing tier', async () => {
      const existing = makeTier({
        override_route: route('gpt-4o'),
      });
      tierRepo.findOne.mockResolvedValue(existing);

      await service.clearOverride('agent-1', 'simple');

      expect(existing.override_route).toBeNull();
      expect(tierRepo.save).toHaveBeenCalledWith(existing);
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });

    it('should be a no-op when tier does not exist', async () => {
      tierRepo.findOne.mockResolvedValue(null);

      await service.clearOverride('agent-1', 'nonexistent');

      expect(tierRepo.save).not.toHaveBeenCalled();
      expect(routingCache.invalidateAgent).not.toHaveBeenCalled();
    });
  });

  /* ── resetAllOverrides ── */

  describe('resetAllOverrides', () => {
    it('should reset all overrides and fallbacks for agent', async () => {
      await service.resetAllOverrides('agent-1');

      expect(tierRepo.update).toHaveBeenCalledWith(
        { agent_id: 'agent-1' },
        expect.objectContaining({
          override_route: null,
          fallback_routes: null,
        }),
      );
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });
  });

  /* ── getFallbacks ── */

  describe('getFallbacks', () => {
    it('should return fallback routes when tier exists', async () => {
      const fallbacks = [route('gpt-4o'), route('claude-3-haiku', 'anthropic')];
      tierRepo.findOne.mockResolvedValue(makeTier({ fallback_routes: fallbacks }));

      const result = await service.getFallbacks('agent-1', 'simple');

      expect(result).toEqual(fallbacks);
    });

    it('should return empty array when tier has no fallbacks', async () => {
      tierRepo.findOne.mockResolvedValue(makeTier({ fallback_routes: null }));

      const result = await service.getFallbacks('agent-1', 'simple');

      expect(result).toEqual([]);
    });

    it('should return empty array when tier does not exist', async () => {
      tierRepo.findOne.mockResolvedValue(null);

      const result = await service.getFallbacks('agent-1', 'nonexistent');

      expect(result).toEqual([]);
    });
  });

  /* ── setFallbacks ── */

  describe('setFallbacks', () => {
    it('should set fallback routes on existing tier', async () => {
      const existing = makeTier();
      const fallbacks = [route('gpt-4o'), route('claude-3-haiku', 'anthropic')];
      tierRepo.findOne.mockResolvedValue(existing);

      const result = await service.setFallbacks('agent-1', 'simple', fallbacks);

      expect(existing.fallback_routes).toEqual(fallbacks);
      expect(tierRepo.save).toHaveBeenCalledWith(existing);
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
      expect(result).toEqual(fallbacks);
    });

    it('should set fallback_routes to null when empty array provided', async () => {
      const existing = makeTier({ fallback_routes: [route('gpt-4o')] });
      tierRepo.findOne.mockResolvedValue(existing);

      const result = await service.setFallbacks('agent-1', 'simple', []);

      expect(existing.fallback_routes).toBeNull();
      expect(result).toEqual([]);
    });

    it('should return empty array when tier does not exist', async () => {
      tierRepo.findOne.mockResolvedValue(null);

      const result = await service.setFallbacks('agent-1', 'nonexistent', [route('gpt-4o')]);

      expect(result).toEqual([]);
      expect(tierRepo.save).not.toHaveBeenCalled();
    });

    it('should reject fallback routes outside the discovered route list', async () => {
      const existing = makeTier();
      tierRepo.findOne.mockResolvedValue(existing);

      await expect(
        service.setFallbacks('agent-1', 'simple', [route('gpt-does-not-exist')]),
      ).rejects.toThrow(BadRequestException);

      expect(tierRepo.save).not.toHaveBeenCalled();
      expect(routingCache.invalidateAgent).not.toHaveBeenCalled();
    });
  });

  /* ── clearFallbacks ── */

  describe('clearFallbacks', () => {
    it('should clear fallback routes on existing tier', async () => {
      const existing = makeTier({ fallback_routes: [route('gpt-4o')] });
      tierRepo.findOne.mockResolvedValue(existing);

      await service.clearFallbacks('agent-1', 'simple');

      expect(existing.fallback_routes).toBeNull();
      expect(tierRepo.save).toHaveBeenCalledWith(existing);
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });

    it('should be a no-op when tier does not exist', async () => {
      tierRepo.findOne.mockResolvedValue(null);

      await service.clearFallbacks('agent-1', 'nonexistent');

      expect(tierRepo.save).not.toHaveBeenCalled();
      expect(routingCache.invalidateAgent).not.toHaveBeenCalled();
    });
  });
});
