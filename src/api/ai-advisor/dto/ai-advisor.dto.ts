import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
  ValidateIf,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AI_PROVIDERS } from '../providers/types';

export class UpsertProviderConfigDto {
  @ApiProperty({ enum: AI_PROVIDERS })
  @IsIn(AI_PROVIDERS)
  provider: (typeof AI_PROVIDERS)[number];

  @ApiPropertyOptional({ example: 'gpt-4o-mini' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  model?: string;

  @ApiPropertyOptional({ example: 'Work OpenAI' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  display_name?: string;

  @ApiPropertyOptional({
    description: 'API key for OpenAI / Anthropic / local (optional for local)',
  })
  @IsOptional()
  @IsString()
  @MinLength(4)
  api_key?: string;

  @ApiPropertyOptional({
    description: 'OpenAI-compatible base URL for local provider',
    example: 'http://127.0.0.1:11434/v1',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  base_url?: string;

  @ApiPropertyOptional({ description: 'Vertex project id' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  project_id?: string;

  @ApiPropertyOptional({ example: 'us-central1' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  location?: string;

  @ApiPropertyOptional({
    description: 'Vertex service-account JSON string',
  })
  @IsOptional()
  @IsString()
  service_account_json?: string;
}

export class SelectActiveProviderDto {
  @ApiProperty({ enum: AI_PROVIDERS })
  @IsIn(AI_PROVIDERS)
  provider: (typeof AI_PROVIDERS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  model?: string;
}

export class UpdateMasterPromptDto {
  @ApiPropertyOptional({
    description: 'User customization layer. Empty string resets to default.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  master_prompt?: string;
}

export class ChatMessageDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  content: string;

  @ApiPropertyOptional({ description: 'Continue an existing conversation' })
  @IsOptional()
  @IsString()
  conversation_id?: string;

  @ApiPropertyOptional({ type: () => [ChatAttachmentDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => ChatAttachmentDto)
  attachments?: ChatAttachmentDto[];
}

export class ChatAttachmentDto {
  @ApiProperty()
  @IsString()
  @MaxLength(180)
  name: string;

  @ApiProperty()
  @IsString()
  @Matches(
    /^(image\/(png|jpeg|webp|gif)|application\/pdf|text\/plain|text\/csv|application\/json)$/,
    { message: 'Unsupported attachment type.' },
  )
  mime_type: string;

  @ApiProperty({ description: 'Base64 payload without a data URL prefix' })
  @IsString()
  @MaxLength(7_000_000)
  data_base64: string;
}

export class CreateAiMemoryDto {
  @ApiProperty({ description: 'A durable preference, goal, or fact FinOS should remember' })
  @IsString()
  @MinLength(2)
  @MaxLength(1000)
  content: string;
}

export class UpdateAiMemoryPreferenceDto {
  @ApiProperty()
  @IsBoolean()
  enabled: boolean;
}
