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
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SUPPORTED_CURRENCIES } from 'src/common/currency/currency.data';

export const ASSET_TYPES = [
  'stock',
  'mutual_fund',
  'etf',
  'gold',
  'crypto',
  'bond',
  'real_estate',
  'other',
] as const;

export class CreateInvestmentDto {
  @ApiProperty({ example: 'HDFC Bank' })
  @IsString()
  @MaxLength(150)
  name: string;

  @ApiPropertyOptional({ example: 'HDFCBANK' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  symbol?: string;

  @ApiPropertyOptional({ example: 'stock', enum: ASSET_TYPES })
  @IsOptional()
  @IsIn(ASSET_TYPES)
  asset_type?: (typeof ASSET_TYPES)[number];

  @ApiProperty({ example: 10 })
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(0)
  @Type(() => Number)
  quantity: number;

  @ApiProperty({ example: 1450.5, description: 'Average cost per unit' })
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(0)
  @Type(() => Number)
  avg_cost: number;

  @ApiProperty({ example: 1620, description: 'Current price per unit' })
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(0)
  @Type(() => Number)
  current_price: number;

  @ApiPropertyOptional({ example: 'INR', enum: SUPPORTED_CURRENCIES })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  @IsIn(SUPPORTED_CURRENCIES)
  currency?: string;

  @ApiPropertyOptional({
    description: 'Link to an investment / gold / crypto container',
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
