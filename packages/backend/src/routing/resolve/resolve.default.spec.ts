jest.mock('../../scoring', () => {
  const scoreRequest = jest.fn();
  const scanMessages = jest.fn();
  return { scoreRequest, scanMessages };
});

import { Repository } from 'typeorm';
import { ResolveService } from './resolve.service';
import { TierService } from '../routing-core/tier.service';
import { ProviderKeyService } from '../routing-core/provider-key.service';
import { SpecificityService } from '../routing-core/specificity.service';
import { SpecificityPenaltyService } from '../routing-core/specificity-penalty.service';
import { HeaderTierService } from '../header-tiers/header-tier.service';
import { Agent } from '../../entities/agent.entity';
import type { AuthType, ModelRoute } from 'manifest-shared';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const scoring = require('../../scoring');

function route(model: string, provider = 'OpenAI', authType: AuthType = 'api_key'): ModelRoute {
  return { provider, authType, model };
}

function tierRow(row: Record<string, any>): Record<string, any> {
  return {
    ...row,
    override_route:
      row.override_route ??
      (row.override_model
        ? route(
            row.override_model,
            row.override_provider ?? 'OpenAI',
            row.override_auth_type ?? 'api_key',
          )
        : null),
    auto_assigned_route:
      row.auto_assigned_route ??
      (row.auto_assigned_model
        ? route(row.auto_assigned_model, row.auto_provider ?? 'OpenAI')
        : null),
    fallback_routes:
      row.fallback_routes ??
      row.fallback_models?.map((model: string) =>
        route(model, row.fallback_provider ?? 'OpenAI'),
      ) ??
      null,
  };
}

function withLegacyAliases(response: any): any {
  return {
    ...response,
    model: response.route?.model ?? null,
    provider: response.route?.provider ?? null,
    auth_type: response.route?.authType ?? null,
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

function buildService(opts: {
  tiers?: Record<string, unknown>[];
  defaultTier?: Record<string, unknown>;
  getEffectiveModel?: unknown;
}) {
  const tierRows = opts.tiers ?? [
    opts.defaultTier ?? { tier: 'default', override_model: null, auto_assigned_model: null },
  ];

  const tierService = {
    getTiers: jest.fn().mockResolvedValue(tierRows.map(tierRow)),
  } as unknown as TierService;

  const providerKeyService = {
    getEffectiveModel: opts.getEffectiveModel ?? jest.fn().mockResolvedValue('openai/gpt-4o-mini'),
    getAuthType: jest.fn().mockResolvedValue('api_key'),
    hasActiveProvider: jest.fn().mockResolvedValue(true),
    isModelAvailable: jest.fn().mockResolvedValue(true),
    isRouteAvailable: jest.fn().mockResolvedValue(true),
  } as unknown as ProviderKeyService;

  const specificityService = {
    getActiveAssignments: jest.fn().mockResolvedValue([]),
  } as unknown as SpecificityService;

  return wrapResolveService(
    new ResolveService(
      tierService,
      providerKeyService,
      specificityService,
      {
        getPenaltiesForAgent: jest.fn().mockResolvedValue(new Map()),
      } as unknown as SpecificityPenaltyService,
      {
        list: jest.fn().mockResolvedValue([]),
      } as unknown as HeaderTierService,
      {
        findOne: jest.fn().mockResolvedValue({ complexity_routing_enabled: true }),
      } as unknown as Repository<Agent>,
    ),
  );
}

describe('ResolveService — default tier catch-all', () => {
  beforeEach(() => jest.clearAllMocks());

  it('scores every request and uses the scored tier when it has an assignment', async () => {
    scoring.scanMessages.mockReturnValue(null);
    scoring.scoreRequest.mockReturnValue({
      tier: 'simple',
      confidence: 1,
      score: 0,
      reason: 'scored',
    });
    const svc = buildService({
      defaultTier: {
        tier: 'simple',
        override_model: null,
        auto_assigned_model: 'openai/gpt-4o-mini',
        override_provider: null,
        override_auth_type: null,
      },
    });

    const out = await svc.resolve('agent-1', [{ role: 'user', content: 'hi' }]);

    expect(scoring.scoreRequest).toHaveBeenCalled();
    expect(out.tier).toBe('simple');
    expect(out.reason).toBe('scored');
  });

  it('falls back to the default tier when the scored tier has no assignment', async () => {
    scoring.scanMessages.mockReturnValue(null);
    scoring.scoreRequest.mockReturnValue({
      tier: 'reasoning',
      confidence: 1,
      score: 0,
      reason: 'scored',
    });
    const svc = buildService({
      // Only a 'default' tier is configured; 'reasoning' is missing, so the
      // resolver must fall through to the default catch-all.
      tiers: [
        {
          tier: 'default',
          override_model: null,
          auto_assigned_model: 'openai/gpt-4o-mini',
          override_provider: null,
          override_auth_type: null,
          fallback_models: ['openai/gpt-4o'],
        },
      ],
    });

    const out = await svc.resolve('agent-1', [{ role: 'user', content: 'hi' }]);

    expect(out.tier).toBe('default');
    expect(out.reason).toBe('default');
    expect(out.model).toBe('openai/gpt-4o-mini');
    expect(out.fallback_models).toEqual(['openai/gpt-4o']);
  });

  it('returns a null model when the default fallback has no resolvable model', async () => {
    scoring.scanMessages.mockReturnValue(null);
    scoring.scoreRequest.mockReturnValue({
      tier: 'reasoning',
      confidence: 1,
      score: 0,
      reason: 'scored',
    });
    const svc = buildService({
      tiers: [
        {
          tier: 'default',
          override_model: null,
          auto_assigned_model: null,
          override_provider: null,
          override_auth_type: null,
        },
      ],
      getEffectiveModel: jest.fn().mockResolvedValue(null),
    });

    const out = await svc.resolve('agent-1', [{ role: 'user', content: 'hi' }]);

    expect(out.tier).toBe('default');
    expect(out.reason).toBe('default');
    expect(out.model).toBeNull();
    expect(out.provider).toBeNull();
  });

  it('skips complexity scoring and uses default tier when complexity_routing_enabled is false', async () => {
    scoring.scanMessages.mockReturnValue(null);
    scoring.scoreRequest.mockReturnValue({
      tier: 'complex',
      confidence: 1,
      score: 80,
      reason: 'scored',
    });

    const tierService = {
      getTiers: jest.fn().mockResolvedValue([
        tierRow({
          tier: 'default',
          override_model: 'openai/gpt-4o-mini',
          auto_assigned_model: null,
          override_provider: null,
          override_auth_type: null,
        }),
      ]),
    } as unknown as TierService;

    const providerKeyService = {
      getEffectiveModel: jest.fn().mockResolvedValue('openai/gpt-4o-mini'),
      getAuthType: jest.fn().mockResolvedValue('api_key'),
      hasActiveProvider: jest.fn().mockResolvedValue(true),
      isModelAvailable: jest.fn().mockResolvedValue(true),
      isRouteAvailable: jest.fn().mockResolvedValue(true),
    } as unknown as ProviderKeyService;

    const svc = wrapResolveService(
      new ResolveService(
        tierService,
        providerKeyService,
        { getActiveAssignments: jest.fn().mockResolvedValue([]) } as unknown as SpecificityService,
        {
          getPenaltiesForAgent: jest.fn().mockResolvedValue(new Map()),
        } as unknown as SpecificityPenaltyService,
        { list: jest.fn().mockResolvedValue([]) } as unknown as HeaderTierService,
        {
          findOne: jest.fn().mockResolvedValue({ complexity_routing_enabled: false }),
        } as unknown as Repository<Agent>,
      ),
    );

    const out = await svc.resolve('agent-1', [
      { role: 'user', content: 'build a complex React app' },
    ]);

    expect(scoring.scoreRequest).not.toHaveBeenCalled();
    expect(out.tier).toBe('default');
    expect(out.reason).toBe('default');
  });
});
