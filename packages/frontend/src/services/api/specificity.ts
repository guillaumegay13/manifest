import { fetchJson, fetchMutate, routingPath } from './core.js';
import type { ModelRoute } from './routing.js';

export interface SpecificityAssignment {
  id: string;
  agent_id: string;
  category: string;
  is_active: boolean;
  override_route: ModelRoute | null;
  auto_assigned_route: ModelRoute | null;
  fallback_routes: ModelRoute[] | null;
  updated_at: string;
}

export function getSpecificityAssignments(agentName: string) {
  return fetchJson<SpecificityAssignment[]>(routingPath(agentName, 'specificity'));
}

export function toggleSpecificity(agentName: string, category: string, active: boolean) {
  return fetchMutate<SpecificityAssignment>(
    routingPath(agentName, `specificity/${encodeURIComponent(category)}/toggle`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active }),
    },
  );
}

export function overrideSpecificity(agentName: string, category: string, route: ModelRoute) {
  return fetchMutate<SpecificityAssignment>(
    routingPath(agentName, `specificity/${encodeURIComponent(category)}`),
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ route }),
    },
  );
}

export function resetSpecificity(agentName: string, category: string) {
  return fetchMutate(routingPath(agentName, `specificity/${encodeURIComponent(category)}`), {
    method: 'DELETE',
  });
}

export function setSpecificityFallbacks(agentName: string, category: string, routes: ModelRoute[]) {
  return fetchMutate<ModelRoute[]>(
    routingPath(agentName, `specificity/${encodeURIComponent(category)}/fallbacks`),
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ routes }),
    },
  );
}

export function clearSpecificityFallbacks(agentName: string, category: string) {
  return fetchMutate(
    routingPath(agentName, `specificity/${encodeURIComponent(category)}/fallbacks`),
    { method: 'DELETE' },
  );
}

export function resetAllSpecificity(agentName: string) {
  return fetchMutate(routingPath(agentName, 'specificity/reset-all'), {
    method: 'POST',
  });
}
