import {
  IsUUID,
  IsString,
  IsOptional,
  IsBoolean,
  IsNumber,
  MaxLength,
  Length,
  IsPositive,
} from 'class-validator';

import { Type } from 'class-transformer';

export class CreateCategoryDto {

  // Inject from JWT guard — do NOT trust frontend
  @IsOptional()
  @IsUUID()
  user_id?: string;

  @IsString()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  // HEX color like #3B82F6
  @IsOptional()
  @IsString()
  @Length(4, 7)
  color?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  icon?: string;

  // Parent category (for nested categories)
  @IsOptional()
  @IsUUID()
  parent_id?: string;

  // System categories should normally be backend controlled
  @IsOptional()
  @IsBoolean()
  is_system?: boolean;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Type(() => Number)
  budget_amount?: number;

  /**
   * Example values:
   * DAILY | WEEKLY | MONTHLY | YEARLY
   */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  budget_period?: string;
}
