import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SetSpecificityOverrideDto, ToggleSpecificityDto } from './specificity.dto';

describe('SetSpecificityOverrideDto', () => {
  function toDto(data: Record<string, unknown>): SetSpecificityOverrideDto {
    return plainToInstance(SetSpecificityOverrideDto, data);
  }

  it('accepts a route', async () => {
    const dto = toDto({
      route: { provider: 'openai', authType: 'api_key', model: 'gpt-4o' },
    });

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects a missing route', async () => {
    const dto = toDto({});

    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-object route', async () => {
    const dto = toDto({ route: 'gpt-4o' });

    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('ToggleSpecificityDto', () => {
  it('accepts a boolean active flag', async () => {
    const dto = plainToInstance(ToggleSpecificityDto, { active: true });

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});
