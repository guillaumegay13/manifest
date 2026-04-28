import { ScoringReason } from '../../scoring';
import type { ModelRoute, SpecificityCategory, TierSlot } from 'manifest-shared';

export type { AuthType } from 'manifest-shared';

export interface ResolveResponse {
  tier: TierSlot;
  route: ModelRoute | null;
  fallback_routes?: ModelRoute[];
  confidence: number;
  score: number;
  reason: ScoringReason;
  specificity_category?: SpecificityCategory;
  header_tier_id?: string;
  header_tier_name?: string;
  header_tier_color?: string;
}
