import {
  IsUUID,
  IsNumber,
  IsString,
  IsOptional,
  IsDateString,
  IsBoolean,
  IsObject,
  IsArray,
  IsPositive,
  Length,
  MaxLength,
  IsISO8601,
} from 'class-validator';

import { Type } from 'class-transformer';

export class CreateExpenseDto {

  @IsOptional()
  @IsUUID()
  user_id?: string; // usually injected from auth guard

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Type(() => Number)
  amount: number;

  @IsString()
  @MaxLength(500)
  description: string;

  @IsDateString()
  date: string;

  @IsOptional()
  @IsISO8601()
  time?: string;

  @IsOptional()
  @IsUUID()
  category_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  merchant?: string;

  // JSONB
  @IsOptional()
  @IsObject()
  location?: Record<string, any>;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  payment_method?: string;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Type(() => Number)
  exchange_rate?: number;

  @IsOptional()
  @IsBoolean()
  is_recurring?: boolean;

  @IsOptional()
  @IsObject()
  recurrence_pattern?: Record<string, any>;

  @IsOptional()
  @IsBoolean()
  is_shared?: boolean;

  @IsOptional()
  @IsObject()
  shared_with?: Record<string, any>;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsArray()
  attachments?: any[];

  @IsOptional()
  @IsObject()
  custom_fields?: Record<string, any>;
}
