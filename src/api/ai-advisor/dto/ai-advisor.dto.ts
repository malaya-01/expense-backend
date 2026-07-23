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

  @ApiPropertyOptional({
    description: 'Ground the answer with current public web sources',
  })
  @IsOptional()
  @IsBoolean()
  web_search?: boolean;

  @ApiPropertyOptional({
    description:
      'Tools invoked via @mentions or slash commands (e.g. list_loans, simulate_scenario)',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  invoked_tools?: string[];
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

export class RenameConversationDto {
  @ApiProperty({ example: 'June cashflow review' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title: string;
}

export class PinConversationDto {
  @ApiProperty()
  @IsBoolean()
  pinned: boolean;
}

export class ArchiveConversationDto {
  @ApiProperty()
  @IsBoolean()
  archived: boolean;
}

export class UploadAiDocumentDto {
  @ApiProperty()
  @IsString()
  @MaxLength(180)
  name: string;

  @ApiProperty()
  @IsString()
  @Matches(
    /^(image\/(png|jpeg|webp|gif)|application\/pdf|text\/plain|text\/csv|application\/json)$/,
    { message: 'Unsupported document type.' },
  )
  mime_type: string;

  @ApiProperty({ description: 'Base64 payload without a data URL prefix' })
  @IsString()
  @MaxLength(7_000_000)
  data_base64: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  conversation_id?: string;
}

export class BulkProposalsDto {
  @ApiPropertyOptional({
    description: 'Proposal IDs to confirm and execute',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  confirm_ids?: string[];

  @ApiPropertyOptional({
    description: 'Proposal IDs to reject',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  reject_ids?: string[];
}

export class SuggestCategoryIconDto {
  @ApiProperty({ example: 'Groceries' })
  @IsString()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({ example: 'Supermarket and household food' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
