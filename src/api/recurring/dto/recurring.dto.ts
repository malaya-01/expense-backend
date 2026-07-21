import { PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateRecurringScheduleDto {
  @IsString()
  @MaxLength(140)
  name: string;

  @IsIn(['expense', 'income', 'transfer'])
  transaction_type: 'expense' | 'income' | 'transfer';

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount: number;

  @IsString()
  @MaxLength(500)
  description: string;

  @IsOptional()
  @IsUUID()
  category_id?: string;

  @IsOptional()
  @IsUUID()
  source_container_id?: string;

  @IsOptional()
  @IsUUID()
  destination_container_id?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.000001)
  exchange_rate?: number;

  @IsIn([
    'daily',
    'weekly',
    'biweekly',
    'monthly',
    'quarterly',
    'semiannual',
    'annual',
  ])
  frequency:
    | 'daily'
    | 'weekly'
    | 'biweekly'
    | 'monthly'
    | 'quarterly'
    | 'semiannual'
    | 'annual';

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  start_date: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  end_date?: string;

  @IsOptional()
  @IsIn(['review', 'automatic'])
  execution_mode?: 'review' | 'automatic';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class UpdateRecurringScheduleDto extends PartialType(
  CreateRecurringScheduleDto,
) {
  @IsOptional()
  @IsIn(['draft', 'active', 'paused', 'completed', 'archived'])
  status?: 'draft' | 'active' | 'paused' | 'completed' | 'archived';
}
