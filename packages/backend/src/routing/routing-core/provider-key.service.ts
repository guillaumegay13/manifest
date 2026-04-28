import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { AuthType, ModelRoute } from 'manifest-shared';
import { UserProvider } from '../../entities/user-provider.entity';
import { RoutingCacheService } from './routing-cache.service';
import { ProviderService } from './provider.service';
import { decrypt, getEncryptionSecret } from '../../common/utils/crypto.util';
import { expandProviderNames } from '../../common/utils/provider-aliases';
import { isManifestUsableProvider } from '../../common/utils/subscription-support';

@Injectable()
export class ProviderKeyService {
  private readonly logger = new Logger(ProviderKeyService.name);

  constructor(
    @InjectRepository(UserProvider)
    private readonly providerRepo: Repository<UserProvider>,
    private readonly routingCache: RoutingCacheService,
    private readonly providerService: ProviderService,
  ) {}

  async getProviderApiKey(
    agentId: string,
    provider: string,
    authType?: AuthType,
  ): Promise<string | null> {
    // Ollama runs locally — no API key needed
    if (provider.toLowerCase() === 'ollama') return '';

    const cached = this.routingCache.getApiKey(agentId, provider, authType);
    if (cached !== undefined) return cached;

    const result = await this.resolveProviderApiKey(agentId, provider, authType);
    this.routingCache.setApiKey(agentId, provider, result, authType);
    return result;
  }

  async getAuthType(
    agentId: string,
    provider: string,
    excludeAuthTypes?: Set<string>,
  ): Promise<AuthType> {
    const names = expandProviderNames([provider]);
    const records = await this.providerService.getProviders(agentId);
    let matches = records.filter((r) => r.is_active && names.has(r.provider.toLowerCase()));
    // When the caller knows certain auth types already failed (e.g. during
    // fallback retries), filter them out so the alternate type is preferred.
    if (excludeAuthTypes && excludeAuthTypes.size > 0) {
      const filtered = matches.filter((r) => !excludeAuthTypes.has(r.auth_type));
      if (filtered.length > 0) matches = filtered;
    }
    // Local providers (Ollama, LM Studio) don't store a key — prefer them
    // explicitly before the key-based heuristics below so a local-only
    // record doesn't get overridden by a keyed record for a sibling alias.
    // We trust the DB row's auth_type here: both migrations and the
    // insert-time tagging in CustomProviderService cover Ollama and LM
    // Studio. Matching on CANONICAL_LOCAL_IDS alone would override a
    // user who explicitly tagged the row as subscription (e.g. Ollama
    // Cloud re-aliased) or hand-managed api_key, which is surprising.
    const localMatch = matches.find((r) => r.auth_type === 'local');
    if (localMatch) return 'local';
    // Prefer subscription if both exist and the subscription record has a usable key
    const subMatch = matches.find((r) => r.auth_type === 'subscription' && r.api_key_encrypted);
    if (subMatch) return 'subscription';
    // Fallback: prefer records that have a decryptable key (avoids returning
    // 'subscription' for a keyless record when an api_key record has a real key)
    const withKey = matches.find((r) => r.api_key_encrypted);
    return withKey?.auth_type ?? matches[0]?.auth_type ?? 'api_key';
  }

  async hasActiveProvider(agentId: string, provider: string): Promise<boolean> {
    const names = expandProviderNames([provider]);
    const records = await this.providerService.getProviders(agentId);
    return records.some((r) => r.is_active && names.has(r.provider.toLowerCase()));
  }

  async getProviderRegion(
    agentId: string,
    provider: string,
    authType?: AuthType,
  ): Promise<string | null> {
    const names = expandProviderNames([provider]);
    const records = await this.providerService.getProviders(agentId);
    const matches = records.filter((r) => r.is_active && names.has(r.provider.toLowerCase()));
    const match = authType ? matches.find((r) => r.auth_type === authType) : matches[0];
    return match?.region ?? null;
  }

  async findProviderForModel(agentId: string, model: string): Promise<string | undefined> {
    const providers = await this.providerService.getProviders(agentId);
    for (const p of providers) {
      if (!p.cached_models) continue;
      if (p.cached_models.some((m) => m.id === model)) return p.provider;
    }
    return undefined;
  }

  /**
   * A route is available if the agent has an active provider matching its
   * `(provider, authType)` pair AND the model still appears in that provider's
   * discovered model list. The cached-models check guards against stale tier
   * assignments that point at a model the user has since lost access to.
   */
  async isRouteAvailable(agentId: string, route: ModelRoute): Promise<boolean> {
    const names = expandProviderNames([route.provider]);
    const records = await this.providerService.getProviders(agentId);
    const match = records.find(
      (r) =>
        r.is_active &&
        r.auth_type === route.authType &&
        names.has(r.provider.toLowerCase()) &&
        isManifestUsableProvider(r),
    );
    if (!match) return false;
    if (!match.cached_models || match.cached_models.length === 0) return true;
    return match.cached_models.some((m) => m.id === route.model);
  }

  private async resolveProviderApiKey(
    agentId: string,
    provider: string,
    preferredAuthType?: AuthType,
  ): Promise<string | null> {
    // Custom providers: exact match on provider key, allow empty key for local endpoints
    if (provider.startsWith('custom:')) {
      const record = await this.providerRepo.findOne({
        where: { agent_id: agentId, provider, is_active: true },
      });
      if (!record) return null;
      if (!record.api_key_encrypted) return '';
      try {
        return decrypt(record.api_key_encrypted, getEncryptionSecret());
      } catch {
        this.logger.warn(`Failed to decrypt API key for custom provider ${provider}`);
        return null;
      }
    }

    const names = expandProviderNames([provider]);
    const records = await this.providerRepo.find({
      where: { agent_id: agentId, is_active: true },
    });

    const matches = records.filter(
      (r) => isManifestUsableProvider(r) && names.has(r.provider.toLowerCase()),
    );
    if (matches.length === 0) return null;

    // When a caller explicitly requests an auth type, do not fall through
    // to a different auth type record.
    const candidates = preferredAuthType
      ? matches.filter((m) => m.auth_type === preferredAuthType)
      : [...matches].sort((a, b) => {
          const aPref = a.auth_type === 'api_key' ? 0 : 1;
          const bPref = b.auth_type === 'api_key' ? 0 : 1;
          return aPref - bPref;
        });

    for (const match of candidates) {
      if (!match.api_key_encrypted) continue;
      try {
        return decrypt(match.api_key_encrypted, getEncryptionSecret());
      } catch {
        const label = match.auth_type === 'subscription' ? 'token' : 'API key';
        this.logger.warn(`Failed to decrypt ${label} for provider ${provider}`);
      }
    }

    return null;
  }
}
