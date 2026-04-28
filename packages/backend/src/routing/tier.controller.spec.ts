import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { TierController } from './tier.controller';
import { TierService } from './routing-core/tier.service';
import { ResolveAgentService } from './routing-core/resolve-agent.service';
import { Agent } from '../entities/agent.entity';
import type { AuthUser } from '../auth/auth.instance';

describe('TierController', () => {
  const user = { id: 'user-1' } as AuthUser;
  const route = { provider: 'openai', authType: 'api_key' as const, model: 'm' };
  const fallbackRoutes = [
    { provider: 'openai', authType: 'api_key' as const, model: 'm1' },
    { provider: 'anthropic', authType: 'api_key' as const, model: 'm2' },
  ];
  const agent = {
    id: 'agent-1',
    name: 'demo',
    tenant_id: 'tenant-1',
    complexity_routing_enabled: true,
  };
  let tierService: jest.Mocked<Partial<TierService>>;
  let resolveAgentService: { resolve: jest.Mock; invalidate: jest.Mock };
  let agentRepo: jest.Mocked<Partial<Repository<Agent>>>;
  let toggleQb: Record<string, jest.Mock>;
  let controller: TierController;

  beforeEach(() => {
    tierService = {
      getTiers: jest.fn().mockResolvedValue([]),
      setOverride: jest.fn(),
      clearOverride: jest.fn().mockResolvedValue(undefined),
      resetAllOverrides: jest.fn().mockResolvedValue(undefined),
      getFallbacks: jest.fn().mockResolvedValue([]),
      setFallbacks: jest.fn().mockResolvedValue([]),
      clearFallbacks: jest.fn().mockResolvedValue(undefined),
    };
    resolveAgentService = {
      resolve: jest.fn().mockResolvedValue(agent),
      invalidate: jest.fn(),
    };
    toggleQb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    agentRepo = {
      createQueryBuilder: jest.fn(() => toggleQb as never),
      findOne: jest.fn().mockResolvedValue({ ...agent, complexity_routing_enabled: false }),
    };
    controller = new TierController(
      tierService as unknown as TierService,
      resolveAgentService as unknown as ResolveAgentService,
      agentRepo as unknown as Repository<Agent>,
    );
  });

  it('GET /tiers returns tier rows for the agent', async () => {
    (tierService.getTiers as jest.Mock).mockResolvedValue([{ tier: 'simple' }]);
    const rows = await controller.getTiers(user, { agentName: 'demo' });
    expect(rows).toEqual([{ tier: 'simple' }]);
    expect(tierService.getTiers).toHaveBeenCalledWith('agent-1', 'user-1');
  });

  it('PUT /tiers/:tier accepts the default slot', async () => {
    (tierService.setOverride as jest.Mock).mockResolvedValue({
      tier: 'default',
      override_route: route,
    });
    const out = await controller.setOverride(user, 'demo', 'default', { route });
    expect(out).toEqual({ tier: 'default', override_route: route });
    expect(tierService.setOverride).toHaveBeenCalledWith('agent-1', 'user-1', 'default', route);
  });

  it('PUT /tiers/:tier rejects unknown slots', async () => {
    await expect(
      controller.setOverride(user, 'demo', 'nonsense', { route }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tierService.setOverride).not.toHaveBeenCalled();
  });

  it('DELETE /tiers/:tier clears the override for valid slots', async () => {
    const out = await controller.clearOverride(user, 'demo', 'default');
    expect(out).toEqual({ ok: true });
    expect(tierService.clearOverride).toHaveBeenCalledWith('agent-1', 'default');
  });

  it('DELETE /tiers/:tier rejects unknown slots', async () => {
    await expect(controller.clearOverride(user, 'demo', 'bogus')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('POST /tiers/reset-all clears every override', async () => {
    const out = await controller.resetAllOverrides(user, { agentName: 'demo' });
    expect(out).toEqual({ ok: true });
    expect(tierService.resetAllOverrides).toHaveBeenCalledWith('agent-1');
  });

  it('GET/PUT/DELETE /tiers/:tier/fallbacks validate the slot', async () => {
    (tierService.getFallbacks as jest.Mock).mockResolvedValue([fallbackRoutes[0]]);
    expect(await controller.getFallbacks(user, 'demo', 'default')).toEqual([fallbackRoutes[0]]);

    (tierService.setFallbacks as jest.Mock).mockResolvedValue(fallbackRoutes);
    expect(
      await controller.setFallbacks(user, 'demo', 'default', { routes: fallbackRoutes }),
    ).toEqual(fallbackRoutes);

    expect(await controller.clearFallbacks(user, 'demo', 'default')).toEqual({ ok: true });

    await expect(controller.getFallbacks(user, 'demo', 'bogus')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      controller.setFallbacks(user, 'demo', 'bogus', { routes: [route] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.clearFallbacks(user, 'demo', 'bogus')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('GET complexity/status returns the current flag', async () => {
    const result = await controller.getComplexityStatus(user, 'demo');
    expect(result).toEqual({ enabled: true });
  });

  it('POST complexity/toggle flips the flag and invalidates cache', async () => {
    const result = await controller.toggleComplexity(user, 'demo');
    expect(result).toEqual({ enabled: false });
    expect(agentRepo.createQueryBuilder).toHaveBeenCalled();
    expect(toggleQb.update).toHaveBeenCalledWith(Agent);
    expect(toggleQb.set).toHaveBeenCalledWith({
      complexity_routing_enabled: expect.any(Function),
    });
    const setArg = toggleQb.set.mock.calls[0][0] as Record<string, () => string>;
    expect(setArg['complexity_routing_enabled']()).toBe('NOT complexity_routing_enabled');
    expect(toggleQb.where).toHaveBeenCalledWith('id = :id', { id: 'agent-1' });
    expect(toggleQb.execute).toHaveBeenCalled();
    expect(agentRepo.findOne).toHaveBeenCalledWith({ where: { id: 'agent-1' } });
    expect(resolveAgentService.invalidate).toHaveBeenCalledWith('tenant-1', 'demo');
  });
});
