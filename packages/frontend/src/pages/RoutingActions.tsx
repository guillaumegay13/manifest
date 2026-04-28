import { createSignal, type Accessor, type Setter } from 'solid-js';
import { toast } from '../services/toast-store.js';
import { routeEquals } from 'manifest-shared';
import {
  overrideTier,
  resetTier,
  resetAllTiers,
  setFallbacks,
  type TierAssignment,
  type AuthType,
  type ModelRoute,
} from '../services/api.js';

interface RoutingActionsInput {
  agentName: () => string;
  tiers: Accessor<TierAssignment[] | undefined>;
  mutateTiers: Setter<TierAssignment[] | undefined>;
  refetchAll: () => Promise<void>;
  setInstructionModal: Setter<'enable' | 'disable' | null>;
}

export function createRoutingActions(input: RoutingActionsInput) {
  const [changingTier, setChangingTier] = createSignal<string | null>(null);
  const [resettingAll, setResettingAll] = createSignal(false);
  const [resettingTier, setResettingTier] = createSignal<string | null>(null);
  const [addingFallback, setAddingFallback] = createSignal<string | null>(null);
  const [fallbackOverrides, setFallbackOverrides] = createSignal<Record<string, ModelRoute[]>>({});

  const getTier = (tierId: string): TierAssignment | undefined =>
    input.tiers()?.find((t) => t.tier === tierId);

  const getFallbacksFor = (tierId: string): ModelRoute[] => {
    const overrides = fallbackOverrides();
    if (tierId in overrides) return overrides[tierId]!;
    return getTier(tierId)?.fallback_routes ?? [];
  };

  const handleOverride = async (
    tierId: string,
    modelName: string,
    providerId: string,
    authType?: AuthType,
  ) => {
    if (!authType) return;
    const route: ModelRoute = { provider: providerId, authType, model: modelName };
    setChangingTier(tierId);
    try {
      const updated = await overrideTier(input.agentName(), tierId, route);
      input.mutateTiers((prev) => prev?.map((t) => (t.tier === tierId ? updated : t)));
      toast.success('Routing updated');
    } catch {
      // error toast from fetchMutate
    } finally {
      setChangingTier(null);
    }
  };

  const handleResetAll = async () => {
    setResettingAll(true);
    try {
      await resetAllTiers(input.agentName());
      input.mutateTiers((prev) =>
        prev?.map((t) => ({
          ...t,
          override_route: null,
          fallback_routes: null,
        })),
      );
      toast.success('All tiers reset to auto');
    } catch {
      // error toast from fetchMutate
    } finally {
      setResettingAll(false);
    }
  };

  const handleReset = async (tierId: string) => {
    setResettingTier(tierId);
    try {
      await resetTier(input.agentName(), tierId);
      input.mutateTiers((prev) =>
        prev?.map((t) => (t.tier === tierId ? { ...t, override_route: null } : t)),
      );
      toast.success('Tier reset to auto');
    } catch {
      // error toast from fetchMutate
    } finally {
      setResettingTier(null);
    }
  };

  const handleAddFallback = async (
    tierId: string,
    modelName: string,
    providerId: string,
    authType?: AuthType,
  ) => {
    if (!authType) return;
    const route: ModelRoute = { provider: providerId, authType, model: modelName };
    const tier = getTier(tierId);
    const current = tier?.fallback_routes ?? [];
    if (current.some((r) => routeEquals(r, route))) return;
    const updated: ModelRoute[] = [...current, route];
    setFallbackOverrides((prev) => ({ ...prev, [tierId]: updated }));
    setAddingFallback(tierId);
    try {
      await setFallbacks(input.agentName(), tierId, updated);
      input.mutateTiers((prev) =>
        prev?.map((t) => (t.tier === tierId ? { ...t, fallback_routes: updated } : t)),
      );
      toast.success('Fallback added');
    } catch {
      setFallbackOverrides((prev) => {
        const next = { ...prev };
        delete next[tierId];
        return next;
      });
    } finally {
      setAddingFallback(null);
      setFallbackOverrides((prev) => {
        const next = { ...prev };
        delete next[tierId];
        return next;
      });
    }
  };

  const handleFallbackUpdate = (tierId: string, updatedFallbacks: ModelRoute[]) => {
    setFallbackOverrides((prev) => {
      const next = { ...prev };
      delete next[tierId];
      return next;
    });
    input.mutateTiers((prev) =>
      prev?.map((t) => (t.tier === tierId ? { ...t, fallback_routes: updatedFallbacks } : t)),
    );
  };

  return {
    changingTier,
    resettingAll,
    resettingTier,
    addingFallback,
    getTier,
    getFallbacksFor,
    handleOverride,
    handleResetAll,
    handleReset,
    handleAddFallback,
    handleFallbackUpdate,
  };
}
