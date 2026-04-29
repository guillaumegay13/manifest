import { BadRequestException } from '@nestjs/common';
import type { ModelRoute } from 'manifest-shared';
import type { DiscoveredModel } from '../../model-discovery/model-fetcher';
import type { ModelDiscoveryService } from '../../model-discovery/model-discovery.service';

type AvailableRoute = Pick<DiscoveredModel, 'id' | 'provider' | 'authType'>;
type RouteDiscoveryService = Pick<ModelDiscoveryService, 'getModelsForAgent'>;

function assertRouteIsAvailable(available: AvailableRoute[], route: ModelRoute): void {
  const providerLower = route.provider.toLowerCase();
  const matches = available.filter(
    (m) =>
      m.id === route.model &&
      m.provider.toLowerCase() === providerLower &&
      m.authType === route.authType,
  );
  if (matches.length > 0) return;

  const sameModel = available.filter((m) => m.id === route.model);
  if (sameModel.length === 0) {
    const options = available.map((m) => m.id).slice(0, 20);
    throw new BadRequestException(
      `Model "${route.model}" is not in this agent's discovered model list. ` +
        `Connect the appropriate provider first, or choose from: ${options.join(', ')}${
          available.length > options.length ? ', ...' : ''
        }`,
    );
  }

  throw new BadRequestException(
    `Model "${route.model}" exists for this agent but not via provider "${route.provider}" ` +
      `with auth type "${route.authType}".`,
  );
}

export async function assertRouteIsDiscovered(
  discoveryService: RouteDiscoveryService,
  agentId: string,
  route: ModelRoute,
): Promise<void> {
  const available = await discoveryService.getModelsForAgent(agentId);
  assertRouteIsAvailable(available, route);
}

export async function assertRoutesAreDiscovered(
  discoveryService: RouteDiscoveryService,
  agentId: string,
  routes: ModelRoute[],
): Promise<void> {
  const available = await discoveryService.getModelsForAgent(agentId);
  for (const route of routes) {
    assertRouteIsAvailable(available, route);
  }
}
