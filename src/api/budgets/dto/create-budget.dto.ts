import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SUPPORTED_CURRENCIES } from 'src/common/currency/currency.data';

export const BUDGET_PERIODS = ['weekly', 'monthly', 'yearly'] as const;

export class CreateBudgetDto {
  @ApiProperty({ example: 'Groceries' })
  @IsString()
  @MaxLength(100)
  name: string;

  @ApiProperty({ example: 8000 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Type(() => Number)
  amount: number;

  @ApiPropertyOptional({
    example: 'monthly',
    enum: BUDGET_PERIODS,
  })
  @IsOptional()
  @IsIn(BUDGET_PERIODS)
  period_type?: (typeof BUDGET_PERIODS)[number];

  @ApiPropertyOptional({
    description: 'Category to track. Omit for overall spending.',
  })
  @IsOptional()
  @IsUUID()
  category_id?: string;

  @ApiPropertyOptional({ example: 'INR', enum: SUPPORTED_CURRENCIES })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  @IsIn(SUPPORTED_CURRENCIES)
  currency?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
