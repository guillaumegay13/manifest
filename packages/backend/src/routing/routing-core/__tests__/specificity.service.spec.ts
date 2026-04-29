import { BadRequestException } from '@nestjs/common';
import { SpecificityService } from '../specificity.service';
import { RoutingCacheService } from '../routing-cache.service';
import { ModelDiscoveryService } from '../../../model-discovery/model-discovery.service';
import { SpecificityAssignment } from '../../../entities/specificity-assignment.entity';
import type { AuthType, ModelRoute } from 'manifest-shared';

function makeMockRepo() {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    insert: jest.fn().mockResolvedValue(undefined),
    save: jest.fn().mockImplementation((e: unknown) => Promise.resolve(e)),
    update: jest.fn().mockResolvedValue(undefined),
  };
}

function route(model: string, provider = 'openai', authType: AuthType = 'api_key'): ModelRoute {
  return { provider, authType, model };
}

function makeAssignment(overrides: Partial<SpecificityAssignment> = {}): SpecificityAssignment {
  return Object.assign(new SpecificityAssignment(), {
    id: 'sa-1',
    user_id: 'user-1',
    agent_id: 'agent-1',
    category: 'coding',
    is_active: true,
    override_route: null,
    auto_assigned_route: null,
    fallback_routes: null,
    updated_at: '2025-01-01T00:00:00Z',
    ...overrides,
  });
}

describe('SpecificityService', () => {
  let service: SpecificityService;
  let repo: ReturnType<typeof makeMockRepo>;
  let cache: {
    getSpecificity: jest.Mock;
    setSpecificity: jest.Mock;
    invalidateAgent: jest.Mock;
  };
  let discoveryService: { getModelsForAgent: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    repo = makeMockRepo();
    cache = {
      getSpecificity: jest.fn().mockReturnValue(null),
      setSpecificity: jest.fn(),
      invalidateAgent: jest.fn(),
    };
    discoveryService = {
      getModelsForAgent: jest.fn().mockResolvedValue([
        { id: 'gpt-4o', provider: 'openai', authType: 'api_key' },
        { id: 'gpt-4o', provider: 'openai', authType: 'subscription' },
        { id: 'claude-3', provider: 'anthropic', authType: 'api_key' },
        { id: 'new-model', provider: 'anthropic', authType: 'api_key' },
        { id: 'model-x', provider: 'openai', authType: 'api_key' },
        { id: 'model-a', provider: 'openai', authType: 'api_key' },
        { id: 'model-b', provider: 'anthropic', authType: 'api_key' },
      ]),
    };

    service = new SpecificityService(
      repo as unknown as any,
      cache as unknown as RoutingCacheService,
      discoveryService as unknown as ModelDiscoveryService,
    );
  });

  /* ── getAssignments ── */

  describe('getAssignments', () => {
    it('should return cached assignments when available', async () => {
      const cached = [makeAssignment()];
      cache.getSpecificity.mockReturnValue(cached);

      const result = await service.getAssignments('agent-1');

      expect(result).toBe(cached);
      expect(repo.find).not.toHaveBeenCalled();
    });

    it('should load from DB and cache when cache misses', async () => {
      const rows = [makeAssignment(), makeAssignment({ id: 'sa-2', category: 'web_browsing' })];
      repo.find.mockResolvedValue(rows);

      const result = await service.getAssignments('agent-1');

      expect(result).toEqual(rows);
      expect(repo.find).toHaveBeenCalledWith({ where: { agent_id: 'agent-1' } });
      expect(cache.setSpecificity).toHaveBeenCalledWith('agent-1', rows);
    });
  });

  /* ── getActiveAssignments ── */

  describe('getActiveAssignments', () => {
    it('should return only active assignments', async () => {
      const active = makeAssignment({ is_active: true, category: 'coding' });
      const inactive = makeAssignment({ id: 'sa-2', is_active: false, category: 'web_browsing' });
      repo.find.mockResolvedValue([active, inactive]);

      const result = await service.getActiveAssignments('agent-1');

      expect(result).toHaveLength(1);
      expect(result[0].category).toBe('coding');
      expect(result[0].is_active).toBe(true);
    });

    it('should return empty array when no assignments are active', async () => {
      repo.find.mockResolvedValue([makeAssignment({ is_active: false })]);

      const result = await service.getActiveAssignments('agent-1');

      expect(result).toEqual([]);
    });
  });

  /* ── toggleCategory ── */

  describe('toggleCategory', () => {
    it('should update existing record when found', async () => {
      const existing = makeAssignment({ is_active: false });
      repo.findOne.mockResolvedValue(existing);

      const result = await service.toggleCategory('agent-1', 'user-1', 'coding', true);

      expect(result.is_active).toBe(true);
      expect(result.updated_at).not.toBe('2025-01-01T00:00:00Z');
      expect(repo.save).toHaveBeenCalledWith(existing);
      expect(cache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });

    it('should create new record when none exists', async () => {
      repo.findOne.mockResolvedValue(null);

      const result = await service.toggleCategory('agent-1', 'user-1', 'coding', true);

      expect(result.agent_id).toBe('agent-1');
      expect(result.user_id).toBe('user-1');
      expect(result.category).toBe('coding');
      expect(result.is_active).toBe(true);
      expect(result.override_route).toBeNull();
      expect(repo.insert).toHaveBeenCalled();
      expect(cache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });

    it('should handle concurrent insert by retrying via findOne', async () => {
      const retried = makeAssignment({ is_active: false });
      repo.findOne
        .mockResolvedValueOnce(null) // first call: no existing record
        .mockResolvedValueOnce(retried) // catch: findOne finds the concurrently-inserted row
        .mockResolvedValueOnce(retried); // recursive toggleCategory call: findOne returns it
      repo.insert.mockRejectedValueOnce(new Error('duplicate key'));

      const result = await service.toggleCategory('agent-1', 'user-1', 'coding', true);

      // The retry path finds the record and updates it
      expect(result.is_active).toBe(true);
      expect(repo.save).toHaveBeenCalled();
    });

    it('should return the new record when insert catch finds no retry row', async () => {
      repo.findOne
        .mockResolvedValueOnce(null) // first: no existing
        .mockResolvedValueOnce(null); // retry: still nothing
      repo.insert.mockRejectedValueOnce(new Error('other error'));

      const result = await service.toggleCategory('agent-1', 'user-1', 'coding', false);

      // Falls through the catch, returns the locally-built record
      expect(result.category).toBe('coding');
      expect(result.is_active).toBe(false);
      expect(cache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });
  });

  /* ── setOverride ── */

  describe('setOverride', () => {
    it('should update existing record with override fields', async () => {
      const existing = makeAssignment({ is_active: false });
      const overrideRoute = route('gpt-4o');
      repo.findOne.mockResolvedValue(existing);

      const result = await service.setOverride('agent-1', 'user-1', 'coding', overrideRoute);

      expect(result.override_route).toEqual(overrideRoute);
      expect(result.is_active).toBe(true);
      expect(repo.save).toHaveBeenCalledWith(existing);
      expect(cache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });

    it('should preserve provider and authType from the route', async () => {
      const existing = makeAssignment();
      const overrideRoute = route('gpt-4o');
      repo.findOne.mockResolvedValue(existing);

      const result = await service.setOverride('agent-1', 'user-1', 'coding', overrideRoute);

      expect(result.override_route).toEqual(overrideRoute);
    });

    it('should create new record with is_active=true when none exists', async () => {
      repo.findOne.mockResolvedValue(null);
      const overrideRoute = route('gpt-4o', 'openai', 'subscription');

      const result = await service.setOverride('agent-1', 'user-1', 'web_browsing', overrideRoute);

      expect(result.agent_id).toBe('agent-1');
      expect(result.category).toBe('web_browsing');
      expect(result.is_active).toBe(true);
      expect(result.override_route).toEqual(overrideRoute);
      expect(repo.insert).toHaveBeenCalled();
      expect(cache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });

    it('should preserve provider and authType on new record', async () => {
      repo.findOne.mockResolvedValue(null);
      const overrideRoute = route('claude-3', 'anthropic');

      const result = await service.setOverride('agent-1', 'user-1', 'coding', overrideRoute);

      expect(result.override_route).toEqual(overrideRoute);
    });

    it('should handle concurrent insert by retrying via findOne', async () => {
      const retried = makeAssignment({ override_route: route('old-model') });
      repo.findOne
        .mockResolvedValueOnce(null) // first call: no existing
        .mockResolvedValueOnce(retried) // catch: finds concurrently-inserted row
        .mockResolvedValueOnce(retried); // recursive setOverride call: findOne returns it
      repo.insert.mockRejectedValueOnce(new Error('duplicate key'));

      const result = await service.setOverride(
        'agent-1',
        'user-1',
        'coding',
        route('new-model', 'anthropic'),
      );

      expect(result.override_route).toEqual(route('new-model', 'anthropic'));
      expect(repo.save).toHaveBeenCalled();
    });

    it('should return new record when insert catch finds no retry row', async () => {
      repo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      repo.insert.mockRejectedValueOnce(new Error('other error'));

      const overrideRoute = route('model-x');
      const result = await service.setOverride('agent-1', 'user-1', 'coding', overrideRoute);

      expect(result.override_route).toEqual(overrideRoute);
      expect(result.category).toBe('coding');
      expect(cache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });
  });

  /* ── clearOverride ── */

  describe('clearOverride', () => {
    it('should null out override fields and fallbacks on existing record', async () => {
      const existing = makeAssignment({
        override_route: route('gpt-4o'),
        fallback_routes: [route('gpt-3.5-turbo')],
      });
      repo.findOne.mockResolvedValue(existing);

      await service.clearOverride('agent-1', 'coding');

      expect(existing.override_route).toBeNull();
      expect(existing.fallback_routes).toBeNull();
      expect(repo.save).toHaveBeenCalledWith(existing);
      expect(cache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });

    it('should be a no-op when no existing record found', async () => {
      repo.findOne.mockResolvedValue(null);

      await service.clearOverride('agent-1', 'nonexistent');

      expect(repo.save).not.toHaveBeenCalled();
      expect(cache.invalidateAgent).not.toHaveBeenCalled();
    });
  });

  /* ── resetAll ── */

  describe('resetAll', () => {
    it('should deactivate all assignments and clear overrides', async () => {
      await service.resetAll('agent-1');

      expect(repo.update).toHaveBeenCalledWith(
        { agent_id: 'agent-1' },
        expect.objectContaining({
          is_active: false,
          override_route: null,
          fallback_routes: null,
        }),
      );
      expect(cache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });
  });

  describe('setFallbacks', () => {
    it('sets fallback_routes on existing assignment', async () => {
      const existing = makeAssignment();
      const fallbacks = [route('model-a'), route('model-b', 'anthropic')];
      repo.findOne.mockResolvedValue(existing);

      const result = await service.setFallbacks('agent-1', 'coding', fallbacks);
      expect(result).toEqual(fallbacks);
      expect(existing.fallback_routes).toEqual(fallbacks);
      expect(repo.save).toHaveBeenCalledWith(existing);
      expect(cache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });

    it('clears fallback_routes when empty array', async () => {
      const existing = makeAssignment({ fallback_routes: [route('model-a')] });
      repo.findOne.mockResolvedValue(existing);

      const result = await service.setFallbacks('agent-1', 'coding', []);
      expect(result).toEqual([]);
      expect(existing.fallback_routes).toBeNull();
      expect(repo.save).toHaveBeenCalledWith(existing);
    });

    it('returns empty array when assignment not found', async () => {
      repo.findOne.mockResolvedValue(null);
      const result = await service.setFallbacks('agent-1', 'coding', [route('model-a')]);
      expect(result).toEqual([]);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('rejects fallback routes outside the discovered route list', async () => {
      const existing = makeAssignment();
      repo.findOne.mockResolvedValue(existing);

      await expect(
        service.setFallbacks('agent-1', 'coding', [route('missing-model')]),
      ).rejects.toThrow(BadRequestException);

      expect(repo.save).not.toHaveBeenCalled();
      expect(cache.invalidateAgent).not.toHaveBeenCalled();
    });
  });

  describe('clearFallbacks', () => {
    it('clears fallback_routes on existing assignment', async () => {
      const existing = makeAssignment({ fallback_routes: [route('model-a')] });
      repo.findOne.mockResolvedValue(existing);

      await service.clearFallbacks('agent-1', 'coding');
      expect(existing.fallback_routes).toBeNull();
      expect(repo.save).toHaveBeenCalledWith(existing);
      expect(cache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });

    it('does nothing when assignment not found', async () => {
      repo.findOne.mockResolvedValue(null);
      await service.clearFallbacks('agent-1', 'coding');
      expect(repo.save).not.toHaveBeenCalled();
      expect(cache.invalidateAgent).not.toHaveBeenCalled();
    });
  });
});
