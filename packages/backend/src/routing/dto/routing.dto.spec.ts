import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  AgentNameParamDto,
  ConnectProviderDto,
  CopilotPollDto,
  SetFallbacksDto,
  SetOverrideDto,
} from './routing.dto';

function toDto(data: Record<string, unknown>): AgentNameParamDto {
  return plainToInstance(AgentNameParamDto, data);
}

describe('AgentNameParamDto', () => {
  it('should pass with alphanumeric name', async () => {
    const dto = toDto({ agentName: 'myagent123' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should pass with hyphens', async () => {
    const dto = toDto({ agentName: 'my-agent' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should pass with underscores', async () => {
    const dto = toDto({ agentName: 'my_agent' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should pass with mixed valid characters', async () => {
    const dto = toDto({ agentName: 'Agent-01_test' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should pass with single character', async () => {
    const dto = toDto({ agentName: 'a' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should reject empty string', async () => {
    const dto = toDto({ agentName: '' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should reject name with spaces', async () => {
    const dto = toDto({ agentName: 'my agent' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should reject name with special characters', async () => {
    for (const name of ['agent@home', 'agent!', 'agent.name', 'agent/path', 'agent$']) {
      const dto = toDto({ agentName: name });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  it('should reject missing agentName', async () => {
    const dto = toDto({});
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should reject non-string agentName', async () => {
    const dto = toDto({ agentName: 123 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('ConnectProviderDto', () => {
  function toConnectDto(data: Record<string, unknown>): ConnectProviderDto {
    return plainToInstance(ConnectProviderDto, data);
  }

  it('accepts a known provider id', async () => {
    const dto = toConnectDto({ provider: 'openai', apiKey: 'sk-abcdef' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.provider).toBe('openai');
  });

  it('normalizes provider casing to lowercase', async () => {
    const dto = toConnectDto({ provider: 'OpenAI' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.provider).toBe('openai');
  });

  it('trims whitespace around the provider name', async () => {
    const dto = toConnectDto({ provider: '  anthropic  ' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.provider).toBe('anthropic');
  });

  it('accepts registered aliases (google -> gemini entry)', async () => {
    const dto = toConnectDto({ provider: 'google' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects an unknown provider name', async () => {
    const dto = toConnectDto({ provider: 'made-up-xyz' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    const flat = errors.flatMap((e) => Object.values(e.constraints ?? {}));
    expect(flat.join('\n')).toMatch(/provider must be one of/);
  });

  it('rejects an empty provider', async () => {
    const dto = toConnectDto({ provider: '' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('passes through a non-string provider value without transforming', async () => {
    const dto = toConnectDto({ provider: 42 });
    // Transform preserves non-strings so class-validator can reject via @IsString
    expect(dto.provider).toBe(42 as unknown as string);
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('CopilotPollDto', () => {
  function toPollDto(data: Record<string, unknown>): CopilotPollDto {
    return plainToInstance(CopilotPollDto, data);
  }

  it('should pass with a valid device code', async () => {
    const dto = toPollDto({ deviceCode: 'dc_abc123' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should reject empty deviceCode', async () => {
    const dto = toPollDto({ deviceCode: '' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should reject missing deviceCode', async () => {
    const dto = toPollDto({});
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('SetFallbacksDto', () => {
  function toFallbacksDto(data: Record<string, unknown>): SetFallbacksDto {
    return plainToInstance(SetFallbacksDto, data);
  }

  const route = { provider: 'openai', authType: 'api_key', model: 'gpt-4o' };

  it('should pass with a single route', async () => {
    const dto = toFallbacksDto({ routes: [route] });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should pass with up to 5 routes', async () => {
    const dto = toFallbacksDto({
      routes: [
        route,
        { provider: 'anthropic', authType: 'api_key', model: 'claude-3' },
        { provider: 'gemini', authType: 'api_key', model: 'gemini-pro' },
        { provider: 'openrouter', authType: 'api_key', model: 'llama-3' },
        { provider: 'mistral', authType: 'api_key', model: 'mistral-large' },
      ],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should pass with an empty array', async () => {
    const dto = toFallbacksDto({ routes: [] });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should reject an empty model in a route', async () => {
    const dto = toFallbacksDto({ routes: [route, { ...route, model: '' }] });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should reject more than 5 items', async () => {
    const dto = toFallbacksDto({
      routes: [
        route,
        { ...route, model: 'm2' },
        { ...route, model: 'm3' },
        { ...route, model: 'm4' },
        { ...route, model: 'm5' },
        { ...route, model: 'm6' },
      ],
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should reject a non-string model in the array', async () => {
    const dto = toFallbacksDto({ routes: [route, { ...route, model: 42 }] });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should reject when routes property is missing', async () => {
    const dto = toFallbacksDto({});
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('SetOverrideDto', () => {
  function toOverrideDto(data: Record<string, unknown>): SetOverrideDto {
    return plainToInstance(SetOverrideDto, data);
  }

  it('should pass with a route', async () => {
    const dto = toOverrideDto({
      route: { provider: 'openai', authType: 'api_key', model: 'gpt-4o' },
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should reject when route is missing', async () => {
    const dto = toOverrideDto({});
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should reject when route is not an object', async () => {
    const dto = toOverrideDto({ route: 'gpt-4o' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});
