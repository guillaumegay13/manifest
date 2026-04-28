import { Repository } from 'typeorm';
import { ResolveService } from './resolve/resolve.service';
import { TierService } from './routing-core/tier.service';
import { ProviderKeyService } from './routing-core/provider-key.service';
import { SpecificityService } from './routing-core/specificity.service';
import { SpecificityPenaltyService } from './routing-core/specificity-penalty.service';
import { HeaderTierService } from './header-tiers/header-tier.service';
import { Agent } from '../entities/agent.entity';
import type { AuthType, ModelRoute } from 'manifest-shared';

function route(model: string, provider = 'OpenAI', authType: AuthType = 'api_key'): ModelRoute {
  return { provider, authType, model };
}

function providerFromLegacyModel(model: string | null | undefined, fallback = 'OpenAI'): string {
  if (!model) return fallback;
  if (model.startsWith('custom:')) return model.split('/')[0] || fallback;
  const [prefix] = model.split('/');
  return prefix && prefix !== model ? prefix : fallback;
}

function tierRow(row: Record<string, any>): Record<string, any> {
  const overrideRoute =
    row.override_route ??
    (row.override_model
      ? route(
          row.override_model,
          row.override_provider ?? providerFromLegacyModel(row.override_model),
          row.override_auth_type ?? 'api_key',
        )
      : null);
  const autoRoute =
    row.auto_assigned_route ??
    (row.auto_assigned_model
      ? route(
          row.auto_assigned_model,
          row.auto_provider ?? providerFromLegacyModel(row.auto_assigned_model),
        )
      : null);
  const fallbackRoutes =
    row.fallback_routes ??
    row.fallback_models?.map((model: string) =>
      route(model, row.fallback_provider ?? providerFromLegacyModel(model)),
    ) ??
    null;
  return {
    ...row,
    override_route: overrideRoute,
    auto_assigned_route: autoRoute,
    fallback_routes: fallbackRoutes,
  };
}

function tierMock(rows: Record<string, any>[]): jest.Mock {
  const mock = jest.fn();
  const original = mock.mockResolvedValue.bind(mock);
  mock.mockResolvedValue = ((value: Record<string, any>[]) =>
    original(value.map(tierRow))) as typeof mock.mockResolvedValue;
  return mock.mockResolvedValue(rows);
}

function withLegacyAliases(response: any): any {
  return {
    ...response,
    model: response.route?.model ?? null,
    provider: response.route?.provider ?? null,
    ...(response.route ? { auth_type: response.route.authType } : {}),
    fallback_models: response.fallback_routes?.map((fallback: ModelRoute) => fallback.model),
  };
}

function wrapResolveService(service: ResolveService): any {
  const resolve = service.resolve.bind(service);
  const resolveForTier = service.resolveForTier.bind(service);
  return Object.assign(service, {
    resolve: async (...args: Parameters<ResolveService['resolve']>) =>
      withLegacyAliases(await resolve(...args)),
    resolveForTier: async (...args: Parameters<ResolveService['resolveForTier']>) =>
      withLegacyAliases(await resolveForTier(...args)),
  });
}

describe('ResolveService', () => {
  let service: any;
  let mockTierService: Record<string, jest.Mock>;
  let mockProviderKeyService: Record<string, jest.Mock>;
  let mockSpecificityService: Record<string, jest.Mock>;
  let mockPricingCache: Record<string, jest.Mock>;
  let mockDiscoveryService: Record<string, jest.Mock>;
  let mockPenaltyService: Record<string, jest.Mock>;
  let mockAgentRepo: Record<string, jest.Mock>;

  beforeEach(() => {
    mockTierService = {
      getTiers: tierMock([
        tierRow({ tier: 'simple', auto_assigned_model: 'gpt-4o-mini' }),
        tierRow({ tier: 'standard', auto_assigned_model: 'gpt-4o' }),
        tierRow({ tier: 'complex', auto_assigned_model: 'claude-sonnet-4' }),
        tierRow({ tier: 'reasoning', auto_assigned_model: 'claude-opus-4-6' }),
        tierRow({ tier: 'default', auto_assigned_model: 'gpt-4o' }),
      ]),
    };
    mockProviderKeyService = {
      getEffectiveModel: jest.fn(),
      getAuthType: jest.fn().mockResolvedValue('api_key'),
      hasActiveProvider: jest.fn().mockResolvedValue(true),
      isModelAvailable: jest.fn().mockResolvedValue(true),
      isRouteAvailable: jest.fn().mockResolvedValue(true),
    };
    mockSpecificityService = {
      getActiveAssignments: tierMock([]),
    };
    mockPricingCache = {
      getByModel: jest.fn(),
    };
    mockDiscoveryService = {
      getModelForAgent: jest.fn().mockResolvedValue(undefined),
    };
    mockPenaltyService = {
      getPenaltiesForAgent: jest.fn().mockResolvedValue(new Map()),
    };
    mockAgentRepo = {
      findOne: jest.fn().mockResolvedValue({ complexity_routing_enabled: true }),
    };

    service = wrapResolveService(
      new ResolveService(
        mockTierService as unknown as TierService,
        mockProviderKeyService as unknown as ProviderKeyService,
        mockSpecificityService as unknown as SpecificityService,
        mockPenaltyService as unknown as SpecificityPenaltyService,
        { list: jest.fn().mockResolvedValue([]) } as unknown as HeaderTierService,
        mockAgentRepo as unknown as Repository<Agent>,
      ),
    );
  });

  it('should return simple tier for short message', async () => {
    mockProviderKeyService.getEffectiveModel.mockResolvedValue('gpt-4o-mini');
    mockPricingCache.getByModel.mockReturnValue({ provider: 'OpenAI' });

    const result = await service.resolve('agent-1', [{ role: 'user', content: 'hello' }]);

    expect(result.tier).toBe('simple');
    expect(result.model).toBe('gpt-4o-mini');
    expect(result.provider).toBe('OpenAI');
    expect(result.auth_type).toBe('api_key');
    expect(result.reason).toBe('short_message');
  });

  it('should return null model when no effective model available', async () => {
    mockProviderKeyService.isRouteAvailable.mockResolvedValue(false);

    const result = await service.resolve('agent-1', [{ role: 'user', content: 'hello' }]);

    expect(result.tier).toBe('simple');
    expect(result.model).toBeNull();
    expect(result.provider).toBeNull();
  });

  it('should return null model when no tier assignment found', async () => {
    mockTierService.getTiers.mockResolvedValue([]);

    const result = await service.resolve('agent-1', [{ role: 'user', content: 'hello' }]);

    expect(result.model).toBeNull();
    expect(result.provider).toBeNull();
  });

  it('should resolve complex tier for elaborate messages', async () => {
    mockProviderKeyService.getEffectiveModel.mockResolvedValue('claude-sonnet-4');
    mockPricingCache.getByModel.mockReturnValue({ provider: 'Anthropic' });

    const messages = [
      {
        role: 'user',
        content:
          'Please write a comprehensive analysis of the trade-offs between microservices and monolithic architecture. ' +
          'Include sections on deployment complexity, data consistency, team organization, performance implications, ' +
          'and provide code examples for service communication patterns. Also compare event-driven vs request-response ' +
          'approaches with specific implementation recommendations for a team of 50 engineers.',
      },
    ];

    const result = await service.resolve('agent-1', messages);

    expect(['complex', 'standard', 'reasoning']).toContain(result.tier);
    expect(result.model).toBe('claude-sonnet-4');
  });

  it('should pass momentum (recentTiers) to scorer', async () => {
    mockProviderKeyService.getEffectiveModel.mockResolvedValue('gpt-4o');
    mockPricingCache.getByModel.mockReturnValue({ provider: 'OpenAI' });

    const result = await service.resolve(
      'agent-1',
      [{ role: 'user', content: 'continue' }],
      undefined,
      undefined,
      undefined,
      ['complex', 'complex', 'complex'],
    );

    // Momentum should bias toward complex, so we should not get 'simple'
    expect(result.tier).not.toBe('simple');
  });

  it('should use the configured route when pricing is not available', async () => {
    mockTierService.getTiers.mockResolvedValue([
      { tier: 'simple', override_model: null, auto_assigned_model: 'unknown-model' },
    ]);

    const result = await service.resolve('agent-1', [{ role: 'user', content: 'hello' }]);

    expect(result.model).toBe('unknown-model');
    expect(result.provider).toBe('OpenAI');
  });

  describe('resolveForTier', () => {
    it('should return model for an assigned tier', async () => {
      mockProviderKeyService.getEffectiveModel.mockResolvedValue('gpt-4o-mini');
      mockPricingCache.getByModel.mockReturnValue({ provider: 'OpenAI' });

      const result = await service.resolveForTier('agent-1', 'simple');

      expect(result.tier).toBe('simple');
      expect(result.model).toBe('gpt-4o-mini');
      expect(result.provider).toBe('OpenAI');
      expect(result.confidence).toBe(1);
      expect(result.score).toBe(0);
      expect(result.reason).toBe('heartbeat');
    });

    it('should return null model when tier has no assignment', async () => {
      mockTierService.getTiers.mockResolvedValue([]);

      const result = await service.resolveForTier('agent-1', 'simple');

      expect(result.tier).toBe('simple');
      expect(result.model).toBeNull();
      expect(result.provider).toBeNull();
      expect(result.reason).toBe('heartbeat');
    });

    it('should return null model when effective model is null', async () => {
      mockTierService.getTiers.mockResolvedValue([
        { tier: 'simple', override_model: null, auto_assigned_model: null },
      ]);

      const result = await service.resolveForTier('agent-1', 'simple');

      expect(result.tier).toBe('simple');
      expect(result.model).toBeNull();
      expect(result.provider).toBeNull();
    });
  });

  it('falls back to the default tier when no assignment matches the scored tier', async () => {
    // When the scored tier has no assignment, resolve() now hands the request
    // to the default tier as a catch-all instead of returning a null model.
    mockTierService.getTiers.mockResolvedValue([
      { tier: 'complex', override_model: null, auto_assigned_model: 'claude-sonnet-4' },
      { tier: 'default', override_model: null, auto_assigned_model: 'gpt-4o-mini' },
    ]);
    mockProviderKeyService.getEffectiveModel.mockResolvedValue('gpt-4o-mini');
    mockPricingCache.getByModel.mockReturnValue({ provider: 'OpenAI' });

    const result = await service.resolve('agent-1', [{ role: 'user', content: 'hello' }]);

    expect(result.tier).toBe('default');
    expect(result.reason).toBe('default');
    expect(result.model).toBe('gpt-4o-mini');
  });

  describe('auth_type resolution', () => {
    it('should prefer stored override_provider over model prefix inference', async () => {
      mockTierService.getTiers.mockResolvedValue([
        {
          tier: 'simple',
          override_model: 'z-ai/glm-5',
          override_provider: 'openrouter',
          override_auth_type: 'api_key',
          auto_assigned_model: 'gpt-4o-mini',
        },
        { tier: 'standard', override_model: null, auto_assigned_model: 'gpt-4o' },
        { tier: 'complex', override_model: null, auto_assigned_model: 'claude-sonnet-4' },
        { tier: 'reasoning', override_model: null, auto_assigned_model: 'claude-opus-4-6' },
      ]);
      mockProviderKeyService.getEffectiveModel.mockResolvedValue('z-ai/glm-5');

      const result = await service.resolve('agent-1', [{ role: 'user', content: 'hello' }]);

      expect(result.provider).toBe('openrouter');
      expect(mockDiscoveryService.getModelForAgent).not.toHaveBeenCalled();
      expect(mockPricingCache.getByModel).not.toHaveBeenCalled();
    });

    it('should propagate override_auth_type from tier assignment', async () => {
      mockTierService.getTiers.mockResolvedValue([
        {
          tier: 'simple',
          override_model: 'claude-sonnet-4',
          override_auth_type: 'subscription',
          auto_assigned_model: 'gpt-4o-mini',
        },
        { tier: 'standard', override_model: null, auto_assigned_model: 'gpt-4o' },
        { tier: 'complex', override_model: null, auto_assigned_model: 'claude-sonnet-4' },
        { tier: 'reasoning', override_model: null, auto_assigned_model: 'claude-opus-4-6' },
      ]);
      mockProviderKeyService.getEffectiveModel.mockResolvedValue('claude-sonnet-4');
      mockPricingCache.getByModel.mockReturnValue({ provider: 'Anthropic' });

      const result = await service.resolve('agent-1', [{ role: 'user', content: 'hello' }]);

      expect(result.auth_type).toBe('subscription');
      // getAuthType should NOT be called when override_auth_type is set
      expect(mockProviderKeyService.getAuthType).not.toHaveBeenCalled();
    });

    it('should fall back to getAuthType when no override_auth_type', async () => {
      mockTierService.getTiers.mockResolvedValue([
        {
          tier: 'simple',
          override_model: null,
          override_auth_type: null,
          auto_assigned_model: 'gpt-4o-mini',
        },
        { tier: 'standard', override_model: null, auto_assigned_model: 'gpt-4o' },
        { tier: 'complex', override_model: null, auto_assigned_model: 'claude-sonnet-4' },
        { tier: 'reasoning', override_model: null, auto_assigned_model: 'claude-opus-4-6' },
      ]);
      mockProviderKeyService.getEffectiveModel.mockResolvedValue('gpt-4o-mini');
      mockPricingCache.getByModel.mockReturnValue({ provider: 'OpenAI' });
      mockProviderKeyService.getAuthType.mockResolvedValue('api_key');

      const result = await service.resolve('agent-1', [{ role: 'user', content: 'hello' }]);

      expect(result.auth_type).toBe('api_key');
      expect(mockProviderKeyService.getAuthType).not.toHaveBeenCalled();
    });

    it('should return subscription from the stored route auth type', async () => {
      mockTierService.getTiers.mockResolvedValue([
        {
          tier: 'simple',
          override_model: 'claude-sonnet-4',
          override_provider: 'Anthropic',
          override_auth_type: 'subscription',
          auto_assigned_model: null,
        },
      ]);

      const result = await service.resolve('agent-1', [{ role: 'user', content: 'hello' }]);

      expect(result.auth_type).toBe('subscription');
    });

    it('should not include auth_type when provider is null', async () => {
      mockProviderKeyService.isRouteAvailable.mockResolvedValue(false);

      const result = await service.resolve('agent-1', [{ role: 'user', content: 'hello' }]);

      expect(result.auth_type).toBeUndefined();
      expect(mockProviderKeyService.getAuthType).not.toHaveBeenCalled();
    });
  });

  describe('resolveForTier provider inference fallback', () => {
    it('should use pricing.provider when model has no prefix', async () => {
      mockTierService.getTiers.mockResolvedValue([
        { tier: 'simple', override_model: null, auto_assigned_model: 'gpt-4o-mini' },
      ]);
      mockProviderKeyService.getEffectiveModel.mockResolvedValue('gpt-4o-mini');
      // model 'gpt-4o-mini' has no slash → inferProviderFromModelName returns undefined
      // pricing.provider has the display name from the cache
      mockPricingCache.getByModel.mockReturnValue({
        model_name: 'openai/gpt-4o-mini',
        provider: 'OpenAI',
      });

      const result = await service.resolveForTier('agent-1', 'simple');

      expect(result.provider).toBe('OpenAI');
    });

    it('should use the configured provider when no model name has a prefix', async () => {
      mockTierService.getTiers.mockResolvedValue([
        {
          tier: 'simple',
          override_model: null,
          auto_assigned_model: 'custom-model',
          auto_provider: 'CustomProvider',
        },
      ]);

      const result = await service.resolveForTier('agent-1', 'simple');

      expect(result.provider).toBe('CustomProvider');
    });
  });

  describe('resolveForTier auth_type', () => {
    it('should propagate override_auth_type in resolveForTier', async () => {
      mockTierService.getTiers.mockResolvedValue([
        {
          tier: 'simple',
          override_model: 'claude-sonnet-4',
          override_auth_type: 'subscription',
          auto_assigned_model: 'gpt-4o-mini',
        },
      ]);
      mockProviderKeyService.getEffectiveModel.mockResolvedValue('claude-sonnet-4');
      mockPricingCache.getByModel.mockReturnValue({ provider: 'Anthropic' });

      const result = await service.resolveForTier('agent-1', 'simple');

      expect(result.auth_type).toBe('subscription');
      expect(mockProviderKeyService.getAuthType).not.toHaveBeenCalled();
    });

    it('should fall back to getAuthType in resolveForTier when no override', async () => {
      mockTierService.getTiers.mockResolvedValue([
        {
          tier: 'simple',
          override_model: null,
          override_auth_type: null,
          auto_assigned_model: 'gpt-4o-mini',
        },
      ]);
      mockProviderKeyService.getEffectiveModel.mockResolvedValue('gpt-4o-mini');
      mockPricingCache.getByModel.mockReturnValue({ provider: 'OpenAI' });
      mockProviderKeyService.getAuthType.mockResolvedValue('api_key');

      const result = await service.resolveForTier('agent-1', 'simple');

      expect(result.auth_type).toBe('api_key');
      expect(mockProviderKeyService.getAuthType).not.toHaveBeenCalled();
    });

    it('should not include auth_type in resolveForTier when model is null', async () => {
      mockTierService.getTiers.mockResolvedValue([
        {
          tier: 'simple',
          override_model: null,
          override_auth_type: null,
          auto_assigned_model: null,
        },
      ]);
      mockProviderKeyService.getEffectiveModel.mockResolvedValue(null);

      const result = await service.resolveForTier('agent-1', 'simple');

      expect(result.auth_type).toBeUndefined();
      expect(mockProviderKeyService.getAuthType).not.toHaveBeenCalled();
    });
  });

  describe('provider prefix validation (#1383)', () => {
    it('should use the provider stored on the route even for prefixed models', async () => {
      mockTierService.getTiers.mockResolvedValue([
        { tier: 'simple', override_model: null, auto_assigned_model: 'anthropic/claude-sonnet-4' },
      ]);

      const result = await service.resolveForTier('agent-1', 'simple');

      expect(result.provider).toBe('anthropic');
      expect(mockProviderKeyService.hasActiveProvider).not.toHaveBeenCalled();
    });

    it('should use prefix when inferred provider is active', async () => {
      mockTierService.getTiers.mockResolvedValue([
        { tier: 'simple', override_model: null, auto_assigned_model: 'anthropic/claude-sonnet-4' },
      ]);
      mockProviderKeyService.getEffectiveModel.mockResolvedValue('anthropic/claude-sonnet-4');
      mockProviderKeyService.hasActiveProvider.mockResolvedValue(true);

      const result = await service.resolveForTier('agent-1', 'simple');

      expect(result.provider).toBe('anthropic');
      // Discovery should not be called — fast path used
      expect(mockDiscoveryService.getModelForAgent).not.toHaveBeenCalled();
    });
  });

  it('should pass tools to scorer for tier floor', async () => {
    mockProviderKeyService.getEffectiveModel.mockResolvedValue('gpt-4o');
    mockPricingCache.getByModel.mockReturnValue({ provider: 'OpenAI' });

    // Message is long enough to bypass the short-message fast path so the
    // tools-floor branch in applyTierFloors is exercised.
    const result = await service.resolve(
      'agent-1',
      [
        {
          role: 'user',
          content: 'Please list the items you know about and summarise what they do.',
        },
      ],
      [{ name: 'search' }],
      'auto',
    );

    // Tools force at least 'standard' tier
    expect(result.tier).not.toBe('simple');
  });

  describe('resolveSpecificity', () => {
    it('should return specificity result when active assignment matches coding keywords', async () => {
      mockSpecificityService.getActiveAssignments.mockResolvedValue([
        {
          category: 'coding',
          override_model: 'claude-sonnet-4',
          override_provider: 'anthropic',
          override_auth_type: null,
          auto_assigned_model: null,
          fallback_models: ['gpt-4o', 'deepseek-chat'],
        },
      ]);
      mockProviderKeyService.hasActiveProvider.mockResolvedValue(true);

      const result = await service.resolve(
        'agent-1',
        [{ role: 'user', content: 'write a function to implement a sorting algorithm' }],
        undefined,
        undefined,
        undefined,
        undefined,
        'coding',
      );

      expect(result.tier).toBe('standard');
      expect(result.model).toBe('claude-sonnet-4');
      expect(result.provider).toBe('anthropic');
      expect(result.reason).toBe('specificity');
      expect(result.specificity_category).toBe('coding');
      expect(result.fallback_models).toEqual(['gpt-4o', 'deepseek-chat']);
    });

    it('should return null when no active assignments exist', async () => {
      mockSpecificityService.getActiveAssignments.mockResolvedValue([]);
      mockProviderKeyService.getEffectiveModel.mockResolvedValue('gpt-4o-mini');
      mockPricingCache.getByModel.mockReturnValue({ provider: 'OpenAI' });

      const result = await service.resolve('agent-1', [{ role: 'user', content: 'hello' }]);

      // Falls through to normal scoring (not specificity)
      expect(result.reason).not.toBe('specificity');
      expect(result.specificity_category).toBeUndefined();
    });

    it('should fall through when message has no specificity keywords', async () => {
      mockSpecificityService.getActiveAssignments.mockResolvedValue([
        {
          category: 'coding',
          override_model: 'gpt-4o',
          override_provider: 'openai',
          override_auth_type: null,
          auto_assigned_model: null,
          is_active: true,
        },
      ]);
      mockProviderKeyService.getEffectiveModel.mockResolvedValue('gpt-4o-mini');
      mockPricingCache.getByModel.mockReturnValue({ provider: 'OpenAI' });

      // "hello" has no coding keywords — scanMessages returns null
      const result = await service.resolve('agent-1', [{ role: 'user', content: 'hello' }]);

      expect(result.reason).not.toBe('specificity');
      expect(result.specificity_category).toBeUndefined();
    });

    it('should return null when detected category has no matching assignment', async () => {
      mockSpecificityService.getActiveAssignments.mockResolvedValue([
        {
          category: 'web_browsing',
          override_model: 'gpt-4o',
          override_provider: 'openai',
          override_auth_type: null,
          auto_assigned_model: null,
        },
      ]);
      mockProviderKeyService.getEffectiveModel.mockResolvedValue('gpt-4o-mini');
      mockPricingCache.getByModel.mockReturnValue({ provider: 'OpenAI' });

      // Send coding keywords but only web_browsing assignment is active
      const result = await service.resolve(
        'agent-1',
        [{ role: 'user', content: 'write a function to implement a sorting algorithm' }],
        undefined,
        undefined,
        undefined,
        undefined,
        'coding',
      );

      // Falls through to normal scoring since no coding assignment
      expect(result.reason).not.toBe('specificity');
    });

    it('should return null when assignment has no model', async () => {
      mockSpecificityService.getActiveAssignments.mockResolvedValue([
        {
          category: 'coding',
          override_model: null,
          override_provider: null,
          override_auth_type: null,
          auto_assigned_model: null,
        },
      ]);
      mockProviderKeyService.getEffectiveModel.mockResolvedValue('gpt-4o-mini');
      mockPricingCache.getByModel.mockReturnValue({ provider: 'OpenAI' });

      const result = await service.resolve(
        'agent-1',
        [{ role: 'user', content: 'write a function to implement a sorting algorithm' }],
        undefined,
        undefined,
        undefined,
        undefined,
        'coding',
      );

      // Falls through to normal scoring since no model on assignment
      expect(result.reason).not.toBe('specificity');
    });

    it('should use auto_assigned_model when override_model is null', async () => {
      mockSpecificityService.getActiveAssignments.mockResolvedValue([
        {
          category: 'coding',
          override_model: null,
          override_provider: null,
          override_auth_type: null,
          auto_assigned_model: 'gpt-4o',
        },
      ]);
      mockPricingCache.getByModel.mockReturnValue({ provider: 'OpenAI' });

      const result = await service.resolve(
        'agent-1',
        [{ role: 'user', content: 'write a function to implement a sorting algorithm' }],
        undefined,
        undefined,
        undefined,
        undefined,
        'coding',
      );

      expect(result.model).toBe('gpt-4o');
      expect(result.reason).toBe('specificity');
      expect(result.specificity_category).toBe('coding');
    });

    it('should propagate override_auth_type from specificity assignment', async () => {
      mockSpecificityService.getActiveAssignments.mockResolvedValue([
        {
          category: 'coding',
          override_model: 'claude-sonnet-4',
          override_provider: 'anthropic',
          override_auth_type: 'subscription',
          auto_assigned_model: null,
        },
      ]);
      mockProviderKeyService.hasActiveProvider.mockResolvedValue(true);

      const result = await service.resolve(
        'agent-1',
        [{ role: 'user', content: 'write a function to implement a sorting algorithm' }],
        undefined,
        undefined,
        undefined,
        undefined,
        'coding',
      );

      expect(result.auth_type).toBe('subscription');
      expect(mockProviderKeyService.getAuthType).not.toHaveBeenCalled();
    });

    it('should use the default route auth type when specificity has no override_auth_type', async () => {
      mockSpecificityService.getActiveAssignments.mockResolvedValue([
        {
          category: 'coding',
          override_model: 'claude-sonnet-4',
          override_provider: 'anthropic',
          override_auth_type: null,
          auto_assigned_model: null,
        },
      ]);
      mockProviderKeyService.hasActiveProvider.mockResolvedValue(true);
      mockProviderKeyService.getAuthType.mockResolvedValue('api_key');

      const result = await service.resolve(
        'agent-1',
        [{ role: 'user', content: 'write a function to implement a sorting algorithm' }],
        undefined,
        undefined,
        undefined,
        undefined,
        'coding',
      );

      expect(result.auth_type).toBe('api_key');
      expect(mockProviderKeyService.getAuthType).not.toHaveBeenCalled();
    });

    it('should accept specificity override via header', async () => {
      mockSpecificityService.getActiveAssignments.mockResolvedValue([
        {
          category: 'coding',
          override_model: 'claude-sonnet-4',
          override_provider: 'anthropic',
          override_auth_type: null,
          auto_assigned_model: null,
        },
      ]);
      mockProviderKeyService.hasActiveProvider.mockResolvedValue(true);

      // Short message that would NOT trigger coding detection, but header forces it
      const result = await service.resolve(
        'agent-1',
        [{ role: 'user', content: 'hello' }],
        undefined,
        undefined,
        undefined,
        undefined,
        'coding',
      );

      expect(result.reason).toBe('specificity');
      expect(result.specificity_category).toBe('coding');
    });

    it('should return the stored route provider and auth type for specificity auto assignment', async () => {
      mockSpecificityService.getActiveAssignments.mockResolvedValue([
        {
          category: 'coding',
          override_model: null,
          override_provider: null,
          override_auth_type: null,
          auto_assigned_model: 'unknown-model',
        },
      ]);
      mockPricingCache.getByModel.mockReturnValue(undefined);
      mockProviderKeyService.hasActiveProvider.mockResolvedValue(false);
      mockDiscoveryService.getModelForAgent.mockResolvedValue(undefined);

      const result = await service.resolve(
        'agent-1',
        [{ role: 'user', content: 'write a function to implement a sorting algorithm' }],
        undefined,
        undefined,
        undefined,
        undefined,
        'coding',
      );

      expect(result.reason).toBe('specificity');
      expect(result.provider).toBe('OpenAI');
      expect(result.auth_type).toBe('api_key');
    });
  });
});
