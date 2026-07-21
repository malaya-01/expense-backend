import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SUPPORTED_CURRENCIES } from 'src/common/currency/currency.data';

export const GOAL_TYPES = [
  'emergency_fund',
  'vacation',
  'house',
  'marriage',
  'education',
  'retirement',
  'vehicle',
  'business',
  'other',
] as const;

export class CreateGoalDto {
  @ApiProperty({ example: 'Emergency Fund' })
  @IsString()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({
    example: 'emergency_fund',
    enum: GOAL_TYPES,
  })
  @IsOptional()
  @IsIn(GOAL_TYPES)
  goal_type?: (typeof GOAL_TYPES)[number];

  @ApiProperty({ example: 150000 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Type(() => Number)
  target_amount: number;

  @ApiPropertyOptional({ example: 25000 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  current_amount?: number;

  @ApiPropertyOptional({ example: 'INR', enum: SUPPORTED_CURRENCIES })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  @IsIn(SUPPORTED_CURRENCIES)
  currency?: string;

  @ApiPropertyOptional({ example: '2027-12-31' })
  @IsOptional()
  @IsDateString()
  target_date?: string;

  @ApiPropertyOptional({
    description: 'Link progress to a financial container balance',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== '')
  @IsUUID()
  container_id?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
