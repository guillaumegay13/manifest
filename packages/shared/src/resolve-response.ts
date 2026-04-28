import type { Tier } from './tiers';
import type { ModelRoute } from './model-route';
import type { SpecificityCategory } from './specificity';

export interface ResolveResponse {
  tier: Tier;
  route: ModelRoute | null;
  fallback_routes?: ModelRoute[];
  confidence: number;
  score: number;
  reason: string;
  specificity_category?: SpecificityCategory;
}
