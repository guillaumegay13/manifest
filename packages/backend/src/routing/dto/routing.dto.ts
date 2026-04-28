import {
  IsString,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsArray,
  ArrayMaxSize,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

import { TIER_SLOTS, AUTH_TYPES, type AuthType } from 'manifest-shared';
import { PROVIDER_BY_ID_OR_ALIAS } from '../../common/constants/providers';

const KNOWN_PROVIDER_IDS: readonly string[] = Array.from(PROVIDER_BY_ID_OR_ALIAS.keys());

export class AgentNameParamDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-zA-Z0-9_-]+$/, { message: 'Invalid agent name' })
  agentName!: string;
}

export class TierParamDto {
  @IsIn(TIER_SLOTS)
  tier!: string;
}

export class ProviderParamDto {
  @IsString()
  @IsNotEmpty()
  provider!: string;
}

export class ConnectProviderDto {
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsIn(KNOWN_PROVIDER_IDS, {
    message: `provider must be one of: ${KNOWN_PROVIDER_IDS.join(', ')}`,
  })
  provider!: string;

  @IsOptional()
  @IsString()
  apiKey?: string;

  @IsOptional()
  @IsIn(AUTH_TYPES)
  authType?: 'api_key' | 'subscription';

  @IsOptional()
  @IsString()
  region?: string;
}

export class AgentProviderParamDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-zA-Z0-9_-]+$/, { message: 'Invalid agent name' })
  agentName!: string;

  @IsString()
  @IsNotEmpty()
  provider!: string;
}

export class RemoveProviderQueryDto {
  @IsOptional()
  @IsIn(AUTH_TYPES)
  authType?: 'api_key' | 'subscription';
}

/**
 * The unit of routing identity. A route is `(provider, authType, model)` — the
 * minimum information needed to send a request and account for it. Two routes
 * with the same model name but different auth types are distinct identities.
 */
export class ModelRouteDto {
  @IsString()
  @IsNotEmpty()
  provider!: string;

  @IsIn(AUTH_TYPES)
  authType!: AuthType;

  @IsString()
  @IsNotEmpty()
  model!: string;
}

export class SetOverrideDto {
  @ValidateNested()
  @Type(() => ModelRouteDto)
  route!: ModelRouteDto;
}

export class CopilotPollDto {
  @IsString()
  @IsNotEmpty()
  deviceCode!: string;
}

export class SetFallbacksDto {
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => ModelRouteDto)
  routes!: ModelRouteDto[];
}
