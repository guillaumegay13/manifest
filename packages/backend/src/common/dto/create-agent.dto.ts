import {
  IsString,
  IsNotEmpty,
  MinLength,
  MaxLength,
  Matches,
  IsOptional,
  IsIn,
  IsBoolean,
} from 'class-validator';
import { AGENT_CATEGORIES, AGENT_PLATFORMS } from 'manifest-shared';

export class CreateAgentDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(100)
  @Matches(/^[a-zA-Z0-9 _-]+$/, {
    message: 'Agent name must contain only letters, numbers, spaces, dashes, and underscores',
  })
  name!: string;

  @IsOptional()
  @IsString()
  @IsIn([...AGENT_CATEGORIES])
  agent_category?: string;

  @IsOptional()
  @IsString()
  @IsIn([...AGENT_PLATFORMS])
  agent_platform?: string;

  /**
   * Explicit Auto-fix choice made at creation. **Omit to inherit.** Sending a
   * value pins the agent, so the create form must only send this when the user
   * actually changed the toggle — echoing back the inherited value would opt
   * every new agent out of the workspace default the moment it is created.
   */
  @IsOptional()
  @IsBoolean()
  autofix_enabled?: boolean;

  /** Explicit recording choice made at creation. Omit to inherit. */
  @IsOptional()
  @IsBoolean()
  record_messages?: boolean;
}
