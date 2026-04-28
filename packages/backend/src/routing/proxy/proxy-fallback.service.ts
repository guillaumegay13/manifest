import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { ModelRoute } from 'manifest-shared';
import { routeEquals } from 'manifest-shared';
import { ProviderKeyService } from '../routing-core/provider-key.service';
import { CustomProvider } from '../../entities/custom-provider.entity';
import { CustomProviderService } from '../custom-provider/custom-provider.service';
import { OpenaiOauthService } from '../oauth/openai-oauth.service';
import { MinimaxOauthService } from '../oauth/minimax-oauth.service';
import { ProviderClient, ForwardResult } from './provider-client';
import {
  buildCustomEndpoint,
  buildEndpointOverride,
  ProviderEndpoint,
  resolveEndpointKey,
} from './provider-endpoints';
import { CopilotTokenService } from './copilot-token.service';
import { buildProviderExtraHeaders } from './provider-hooks';
import { shouldTriggerFallback } from './fallback-status-codes';
import { normalizeMinimaxSubscriptionBaseUrl } from '../provider-base-url';
import { getQwenCompatibleBaseUrl, isQwenResolvedRegion } from '../qwen-region';
import { normalizeAnthropicShortModelId } from '../../common/utils/anthropic-model-id';
import {
  isTransportError,
  buildTransportErrorResponse,
  describeTransportError,
} from './proxy-transport';
import type { SignatureLookup, ThinkingBlockLookup } from './proxy-types';
import type { ProxyApiMode } from './proxy-types';

export interface FailedFallback {
  route: ModelRoute;
  fallbackIndex: number;
  status: number;
  errorBody: string;
}

export interface FallbackSuccess {
  forward: ForwardResult;
  route: ModelRoute;
  fallbackIndex: number;
}

@Injectable()
export class ProxyFallbackService {
  private readonly logger = new Logger(ProxyFallbackService.name);

  constructor(
    private readonly providerKeyService: ProviderKeyService,
    @InjectRepository(CustomProvider)
    private readonly customProviderRepo: Repository<CustomProvider>,
    private readonly openaiOauth: OpenaiOauthService,
    private readonly minimaxOauth: MinimaxOauthService,
    private readonly providerClient: ProviderClient,
    private readonly copilotToken: CopilotTokenService,
  ) {}

  /**
   * Walk the configured fallback routes in order, returning at the first one
   * that returns a 2xx. Routes are explicit `(provider, authType, model)` —
   * no provider inference, no auth inference. This is what makes #1708
   * (subscription→api_key fallback for the same model) work cleanly: the user
   * configures both routes; the resolver hands them over; we just try them.
   */
  async tryFallbacks(
    agentId: string,
    userId: string,
    routes: ModelRoute[],
    body: Record<string, unknown>,
    stream: boolean,
    sessionKey: string,
    primaryRoute: ModelRoute,
    signal?: AbortSignal,
    signatureLookup?: SignatureLookup,
    thinkingLookup?: ThinkingBlockLookup,
    apiMode?: ProxyApiMode,
    chatBody?: Record<string, unknown>,
  ): Promise<{ success: FallbackSuccess | null; failures: FailedFallback[] }> {
    const failures: FailedFallback[] = [];

    for (let i = 0; i < routes.length; i++) {
      const route = routes[i];
      // Skip the route that just failed — it's the primary, retrying it is
      // pointless. Different `(provider, authType, model)` triples are valid
      // even when only one component differs; that's the whole point of the
      // structured route.
      if (routeEquals(route, primaryRoute)) {
        this.logger.debug(`Fallback ${i}: skipping ${describe(route)} (matches primary)`);
        continue;
      }

      const apiKey = await this.providerKeyService.getProviderApiKey(
        agentId,
        route.provider,
        route.authType,
      );
      if (apiKey === null) {
        this.logger.debug(`Fallback ${i}: skipping ${describe(route)} (no API key)`);
        continue;
      }

      const credentials = await resolveApiKey(
        route.provider,
        apiKey,
        route.authType,
        agentId,
        userId,
        this.openaiOauth,
        this.minimaxOauth,
      );
      const providerRegion = await this.providerKeyService.getProviderRegion(
        agentId,
        route.provider,
        route.authType,
      );
      const wireModel = normalizeProviderModel(route.provider, route.model);

      this.logger.log(
        `Fallback ${i}: trying ${describe(route)} (primary=${describe(primaryRoute)})`,
      );

      const forward = await this.tryForwardToProvider({
        provider: route.provider,
        apiKey: credentials.apiKey,
        model: wireModel,
        body,
        chatBody,
        stream,
        sessionKey,
        signal,
        authType: route.authType,
        apiMode,
        resourceUrl: credentials.resourceUrl,
        providerRegion,
        signatureLookup,
        thinkingLookup,
      });

      if (forward.response.ok) {
        return { success: { forward, route, fallbackIndex: i }, failures };
      }

      const errorBody = await forward.response.text();
      failures.push({
        route,
        fallbackIndex: i,
        status: forward.response.status,
        errorBody,
      });

      // Stop on errors we treat as terminal (4xx that aren't worth retrying).
      // The user-visible primary error is preserved by the caller so the
      // client sees the original failure rather than a fallback's error.
      if (!shouldTriggerFallback(forward.response.status)) break;
    }
    return { success: null, failures };
  }

  async tryForwardToProvider(opts: {
    provider: string;
    apiKey: string;
    model: string;
    body: Record<string, unknown>;
    chatBody?: Record<string, unknown>;
    stream: boolean;
    sessionKey: string;
    signal?: AbortSignal;
    authType?: string;
    resourceUrl?: string;
    providerRegion?: string | null;
    apiMode?: ProxyApiMode;
    signatureLookup?: SignatureLookup;
    thinkingLookup?: ThinkingBlockLookup;
  }): Promise<ForwardResult> {
    try {
      return await this.forwardToProvider(opts);
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      if (!isTransportError(error)) throw error;

      const failureResponse = buildTransportErrorResponse(error);
      const message = describeTransportError(error);
      this.logger.warn(
        `Provider transport failure: provider=${opts.provider} model=${opts.model} status=${failureResponse.status} message=${message}`,
      );

      return {
        response: failureResponse,
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      };
    }
  }

  private async forwardToProvider(opts: {
    provider: string;
    apiKey: string;
    model: string;
    body: Record<string, unknown>;
    chatBody?: Record<string, unknown>;
    stream: boolean;
    sessionKey: string;
    signal?: AbortSignal;
    authType?: string;
    resourceUrl?: string;
    providerRegion?: string | null;
    apiMode?: ProxyApiMode;
    signatureLookup?: SignatureLookup;
    thinkingLookup?: ThinkingBlockLookup;
  }): Promise<ForwardResult> {
    const {
      provider,
      body,
      chatBody,
      stream,
      signal,
      authType,
      resourceUrl,
      providerRegion,
      signatureLookup,
      thinkingLookup,
    } = opts;

    const extraHeaders = buildProviderExtraHeaders(provider, opts.sessionKey);

    // Copilot: exchange the stored GitHub OAuth token for a short-lived API token
    let effectiveKey = opts.apiKey;
    if (provider.toLowerCase() === 'copilot') {
      effectiveKey = await this.copilotToken.getCopilotToken(opts.apiKey);
    }

    let customEndpoint: ProviderEndpoint | undefined;
    let forwardModel = opts.model;

    // Strip the "copilot/" prefix -- the Copilot API expects bare model names
    if (provider.toLowerCase() === 'copilot' && forwardModel.startsWith('copilot/')) {
      forwardModel = forwardModel.substring('copilot/'.length);
    }

    if (CustomProviderService.isCustom(provider)) {
      const cpId = CustomProviderService.extractId(provider);
      const cp = await this.customProviderRepo.findOne({ where: { id: cpId } });
      if (cp) {
        customEndpoint = buildCustomEndpoint(cp.base_url, cp.api_kind ?? 'openai');
        forwardModel = CustomProviderService.rawModelName(opts.model);
      }
    } else if (resolveEndpointKey(provider) === 'qwen' && isQwenResolvedRegion(providerRegion)) {
      customEndpoint = buildEndpointOverride(getQwenCompatibleBaseUrl(providerRegion), 'qwen');
    } else if (authType === 'subscription' && provider.toLowerCase() === 'minimax' && resourceUrl) {
      const minimaxBaseUrl = normalizeMinimaxSubscriptionBaseUrl(resourceUrl);
      if (minimaxBaseUrl) {
        customEndpoint = buildEndpointOverride(minimaxBaseUrl, 'minimax-subscription');
      } else {
        this.logger.warn('Ignoring invalid MiniMax subscription resource URL');
      }
    }

    return this.providerClient.forward({
      provider,
      apiKey: effectiveKey,
      model: forwardModel,
      body,
      chatBody,
      stream,
      signal,
      extraHeaders,
      customEndpoint,
      authType,
      apiMode: opts.apiMode,
      signatureLookup,
      thinkingLookup,
    });
  }
}

// ---------------------------------------------------------------------------
// Shared helpers (used by both ProxyService and ProxyFallbackService)
// ---------------------------------------------------------------------------

export function normalizeProviderModel(provider: string, model: string): string {
  return provider.toLowerCase() === 'anthropic' ? normalizeAnthropicShortModelId(model) : model;
}

export async function resolveApiKey(
  provider: string,
  apiKey: string,
  authType: string | undefined,
  agentId: string,
  userId: string,
  openaiOauth: OpenaiOauthService,
  minimaxOauth: MinimaxOauthService,
): Promise<{ apiKey: string; resourceUrl?: string }> {
  if (authType === 'subscription') {
    const lower = provider.toLowerCase();
    if (lower === 'openai') {
      const unwrapped = await openaiOauth.unwrapToken(apiKey, agentId, userId);
      if (unwrapped) return { apiKey: unwrapped };
    }
    if (lower === 'minimax') {
      const unwrapped = await minimaxOauth.unwrapToken(apiKey, agentId, userId);
      if (unwrapped) return { apiKey: unwrapped.t, resourceUrl: unwrapped.u };
    }
  }
  return { apiKey };
}

function describe(route: ModelRoute): string {
  return `${route.provider}/${route.authType}/${route.model}`;
}
