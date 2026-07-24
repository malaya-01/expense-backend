import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreateSpaceDto {
  @ApiProperty({ example: 'Goa Trip' })
  @IsString()
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ example: 'INR' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  icon?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(7)
  color?: string;
}

export class UpdateSpaceDto extends PartialType(CreateSpaceDto) {}

export class InviteMemberDto {
  @ApiProperty({ example: 'friend@example.com' })
  @IsString()
  @MaxLength(255)
  email: string;

  @ApiPropertyOptional({ enum: ['admin', 'member', 'guest'] })
  @IsOptional()
  @IsIn(['admin', 'member', 'guest'])
  role?: 'admin' | 'member' | 'guest';
}

export class UpdateMemberRoleDto {
  @ApiProperty({ enum: ['admin', 'member', 'guest', 'owner'] })
  @IsIn(['admin', 'member', 'guest', 'owner'])
  role: 'admin' | 'member' | 'guest' | 'owner';
}

export class SplitParticipantDto {
  @IsUUID()
  member_id: string;

  @ApiPropertyOptional({ description: 'Exact amount, percent, or share weight' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  share_value?: number;
}

export class CreateSpaceExpenseDto {
  @IsString()
  @MaxLength(200)
  title: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount: number;

  @IsUUID()
  payer_member_id: string;

  @IsIn(['equal', 'exact', 'percentage', 'shares'])
  split_method: 'equal' | 'exact' | 'percentage' | 'shares';

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SplitParticipantDto)
  participants: SplitParticipantDto[];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @IsOptional()
  @IsDateString()
  expense_date?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(180)
  receipt_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  receipt_mime_type?: string;

  @IsOptional()
  @IsString()
  receipt_base64?: string;

  @IsOptional()
  @IsBoolean()
  link_to_personal?: boolean;

  @IsOptional()
  @IsUUID()
  personal_container_id?: string;
}

export class CreateSettlementDto {
  @IsUUID()
  from_member_id: string;

  @IsUUID()
  to_member_id: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(180)
  proof_name?: string;

  @IsOptional()
  @IsString()
  proof_mime_type?: string;

  @IsOptional()
  @IsString()
  proof_base64?: string;

  @IsOptional()
  @IsDateString()
  scheduled_at?: string;

  @IsOptional()
  @IsBoolean()
  link_to_personal?: boolean;

  @IsOptional()
  @IsUUID()
  personal_container_id?: string;
}

export class CreateSpaceBudgetDto {
  @IsString()
  @MaxLength(120)
  name: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount: number;

  @IsOptional()
  @IsIn(['weekly', 'monthly', 'yearly'])
  period_type?: 'weekly' | 'monthly' | 'yearly';

  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class CreateSpaceGoalDto {
  @IsString()
  @MaxLength(120)
  name: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  target_amount: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  current_amount?: number;

  @IsOptional()
  @IsDateString()
  target_date?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class ContributeSpaceGoalDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class SyncOutboxDto {
  @IsString()
  @MaxLength(80)
  client_op_id: string;

  @IsString()
  @MaxLength(40)
  entity_type: string;

  @IsOptional()
  @IsUUID()
  space_id?: string;

  payload: Record<string, unknown>;
}

export class FavoriteSpaceDto {
  @IsBoolean()
  favorite: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  position?: number;
}

export class WalletMovementDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount: number;

  @IsIn(['deposit', 'withdrawal'])
  kind: 'deposit' | 'withdrawal';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
