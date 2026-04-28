import { IsBoolean, IsDefined, IsObject, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ModelRouteDto } from './routing.dto';

export class SetSpecificityOverrideDto {
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => ModelRouteDto)
  route!: ModelRouteDto;
}

export class ToggleSpecificityDto {
  @IsBoolean()
  active!: boolean;
}
