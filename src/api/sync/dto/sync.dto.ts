import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export const SYNC_ENTITY_TYPES = [
  'account',
  'transaction',
  'category',
  'budget',
  'goal',
  'investment',
  'loan',
  'recurring',
  'user_settings',
  'ai_preferences',
  'ai_memory',
  'notification_preferences',
  'goal_contribute',
  'loan_payment',
  'recurring_execute',
] as const;

export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number];

export const SYNC_OPS = [
  'create',
  'update',
  'delete',
  'contribute',
  'payment',
  'execute',
] as const;

export class SyncChangeDto {
  @ApiProperty()
  @IsString()
  @MaxLength(120)
  client_op_id: string;

  @ApiProperty({ enum: SYNC_ENTITY_TYPES })
  @IsIn(SYNC_ENTITY_TYPES)
  entity_type: SyncEntityType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  entity_id?: string;

  @ApiProperty({ enum: SYNC_OPS })
  @IsIn(SYNC_OPS)
  op: (typeof SYNC_OPS)[number];

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  payload?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  client_updated_at?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  base_sync_version?: number;

  @ApiPropertyOptional({
    description: 'Force apply despite version mismatch (Keep Local)',
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

export class SyncPushDto {
  @ApiProperty()
  @IsString()
  @MaxLength(120)
  device_id: string;

  @ApiProperty({ type: [SyncChangeDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SyncChangeDto)
  changes: SyncChangeDto[];
}
