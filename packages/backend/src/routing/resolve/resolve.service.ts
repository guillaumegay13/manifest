import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { IncomingHttpHeaders } from 'http';
import { TierService } from '../routing-core/tier.service';
import { ProviderKeyService } from '../routing-core/provider-key.service';
import { SpecificityService } from '../routing-core/specificity.service';
import { SpecificityPenaltyService } from '../routing-core/specificity-penalty.service';
import { HeaderTierService } from '../header-tiers/header-tier.service';
import { scoreRequest, ScorerInput, MomentumInput, scanMessages } from '../../scoring';
import { ResolveResponse } from '../dto/resolve-response';
import { Agent } from '../../entities/agent.entity';
import type { ModelRoute, SpecificityCategory, TierSlot } from 'manifest-shared';
import type { HeaderTier } from '../../entities/header-tier.entity';

/**
 * When specificity detection is below this confidence, skip specificity
 * routing and fall through to the complexity tier. Low-confidence detections
 * are the ones that misrouted coding sessions to web_browsing (discussion
 * #1613) — the safer call is to route by complexity instead of committing to
 * an ambiguous specificity category. Kept below the typical
 * single-strong-anchor confidence (0.33 for web_browsing at threshold 3) but
 * above the score-equals-threshold minimum, so clean 2-signal detections
 * (keyword + URL, keyword + tool) still pass.
 */
const MIN_SPECIFICITY_CONFIDENCE = 0.4;

interface RouteCarrier {
  override_route: ModelRoute | null;
  auto_assigned_route?: ModelRoute | null;
  fallback_routes: ModelRoute[] | null;
}

@Injectable()
export class ResolveService {
  private readonly logger = new Logger(ResolveService.name);

  constructor(
    private readonly tierService: TierService,
    private readonly providerKeyService: ProviderKeyService,
    private readonly specificityService: SpecificityService,
    private readonly penaltyService: SpecificityPenaltyService,
    private readonly headerTierService: HeaderTierService,
    @InjectRepository(Agent)
    private readonly agentRepo: Repository<Agent>,
  ) {}

  async resolve(
    agentId: string,
    messages: ScorerInput['messages'],
    tools?: ScorerInput['tools'],
    toolChoice?: unknown,
    maxTokens?: number,
    recentTiers?: MomentumInput['recentTiers'],
    specificityOverride?: string,
    recentCategories?: readonly SpecificityCategory[],
    headers?: IncomingHttpHeaders,
  ): Promise<ResolveResponse> {
    if (headers) {
      const headerTierResult = await this.resolveHeaderTier(agentId, headers);
      if (headerTierResult) return headerTierResult;
    }

    const agent = await this.agentRepo.findOne({ where: { id: agentId } });
    if (agent && !agent.complexity_routing_enabled) {
      return this.resolveForTier(agentId, 'default', 'default');
    }

    const specificityResult = await this.resolveSpecificity(
      agentId,
      messages,
      tools,
      specificityOverride,
      recentCategories,
    );
    if (specificityResult) return specificityResult;

    const input: ScorerInput = { messages, tools, tool_choice: toolChoice, max_tokens: maxTokens };
    const momentum: MomentumInput | undefined =
      recentTiers && recentTiers.length > 0 ? { recentTiers } : undefined;
    const result = scoreRequest(input, undefined, momentum);

    const tiers = await this.tierService.getTiers(agentId);
    const assignment = tiers.find((t) => t.tier === result.tier);

    if (!assignment) {
      this.logger.warn(
        `No tier assignment found for agent=${agentId} tier=${result.tier} ` +
          `(available tiers: ${tiers.map((t) => t.tier).join(', ') || 'none'})`,
      );
      return this.resolveForTier(agentId, 'default', 'default');
    }

    const route = await this.effectiveRoute(agentId, assignment);
    if (!route) {
      this.logger.warn(
        `No effective route for agent=${agentId} tier=${result.tier} ` +
          `(override=${describeRoute(assignment.override_route)} ` +
          `auto=${describeRoute(assignment.auto_assigned_route)})`,
      );
      return {
        tier: result.tier,
        route: null,
        confidence: result.confidence,
        score: result.score,
        reason: result.reason,
      };
    }

    return {
      tier: result.tier,
      route,
      fallback_routes: assignment.fallback_routes ?? undefined,
      confidence: result.confidence,
      score: result.score,
      reason: result.reason,
    };
  }

  async resolveForTier(
    agentId: string,
    tier: TierSlot,
    reason: 'heartbeat' | 'default' = 'heartbeat',
  ): Promise<ResolveResponse> {
    const tiers = await this.tierService.getTiers(agentId);
    const assignment = tiers.find((t) => t.tier === tier);

    if (!assignment) {
      return { tier, route: null, confidence: 1, score: 0, reason };
    }

    const route = await this.effectiveRoute(agentId, assignment);

    return {
      tier,
      route,
      fallback_routes: assignment.fallback_routes ?? undefined,
      confidence: 1,
      score: 0,
      reason,
    };
  }

  private async resolveHeaderTier(
    agentId: string,
    headers: IncomingHttpHeaders,
  ): Promise<ResolveResponse | null> {
    const allTiers = await this.headerTierService.list(agentId);
    const tiers = allTiers.filter((t) => t.enabled);
    if (tiers.length === 0) return null;

    const match = tiers.find((t) => matchesHeaderRule(headers, t));
    if (!match) return null;

    if (!match.override_route) {
      this.logger.debug(
        `Header tier "${match.name}" matched but has no route configured — falling through`,
      );
      return null;
    }

    // Guard against orphaned overrides (e.g. a model that was removed after the
    // tier was configured). Mirrors the same check in resolveSpecificity().
    if (!(await this.providerKeyService.isRouteAvailable(agentId, match.override_route))) {
      this.logger.warn(
        `Header tier "${match.name}" route ${describeRoute(match.override_route)} is unavailable ` +
          `for agent=${agentId}; falling through to existing routing`,
      );
      return null;
    }

    return {
      tier: 'standard',
      route: match.override_route,
      fallback_routes: match.fallback_routes ?? undefined,
      confidence: 1,
      score: 0,
      reason: 'header-match',
      header_tier_id: match.id,
      header_tier_name: match.name,
      header_tier_color: match.badge_color,
    };
  }

  private async resolveSpecificity(
    agentId: string,
    messages: ScorerInput['messages'],
    tools?: ScorerInput['tools'],
    headerOverride?: string,
    recentCategories?: readonly SpecificityCategory[],
  ): Promise<ResolveResponse | null> {
    const active = await this.specificityService.getActiveAssignments(agentId);
    if (active.length === 0) return null;

    const penalties = await this.penaltyService.getPenaltiesForAgent(agentId);
    const detected = scanMessages(
      messages,
      tools,
      headerOverride,
      recentCategories,
      penalties.size > 0 ? penalties : undefined,
    );
    if (!detected) return null;

    // Confidence gate: a weak detection (single keyword match, no corroborating
    // signal) is the one that misroutes coding sessions. Fall through to
    // complexity routing instead of committing to the ambiguous category.
    // Header overrides bypass the gate because they are explicit user intent.
    if (!headerOverride && detected.confidence < MIN_SPECIFICITY_CONFIDENCE) {
      this.logger.debug(
        `Specificity detected=${detected.category} ` +
          `confidence=${detected.confidence.toFixed(2)} below ${MIN_SPECIFICITY_CONFIDENCE} — ` +
          `falling through to complexity routing`,
      );
      return null;
    }

    const assignment = active.find((a) => a.category === detected.category);
    if (!assignment) return null;

    const route = await this.effectiveRoute(agentId, assignment);
    if (!route) return null;

    return {
      tier: 'standard',
      route,
      fallback_routes: assignment.fallback_routes ?? undefined,
      confidence: detected.confidence,
      score: 0,
      reason: 'specificity',
      specificity_category: detected.category,
    };
  }

  /**
   * Pick the route that should serve this assignment. Prefer the manual
   * override; if it points to a provider/auth/model that is no longer
   * connected, fall through to the auto-assigned route. Returning null means
   * neither is usable and the caller should fall back to a different tier.
   */
  private async effectiveRoute(
    agentId: string,
    assignment: RouteCarrier,
  ): Promise<ModelRoute | null> {
    if (assignment.override_route) {
      if (await this.providerKeyService.isRouteAvailable(agentId, assignment.override_route)) {
        return assignment.override_route;
      }
      this.logger.warn(
        `Override ${describeRoute(assignment.override_route)} unavailable for agent=${agentId}; ` +
          `trying auto-assigned route`,
      );
    }
    if (assignment.auto_assigned_route) {
      if (await this.providerKeyService.isRouteAvailable(agentId, assignment.auto_assigned_route)) {
        return assignment.auto_assigned_route;
      }
    }
    return null;
  }
}

function describeRoute(route: ModelRoute | null | undefined): string {
  if (!route) return 'null';
  return `${route.provider}/${route.authType}/${route.model}`;
}

function matchesHeaderRule(headers: IncomingHttpHeaders, tier: HeaderTier): boolean {
  const raw = headers[tier.header_key];
  if (raw == null) return false;
  // Node gives repeated headers as string[]; match if any entry equals the rule.
  if (Array.isArray(raw)) return raw.some((v) => v === tier.header_value);
  return raw === tier.header_value;
}
