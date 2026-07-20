import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SUPPORTED_CURRENCIES } from 'src/common/currency/currency.data';

export const CONTAINER_TYPES = [
  'cash',
  'wallet',
  'bank',
  'credit_card',
  'investment',
  'gold',
  'crypto',
  'loan',
  'receivable',
  'payable',
  'other',
] as const;

export class CreateAccountDto {
  @ApiProperty({ example: 'Salary Account' })
  @IsString()
  @MaxLength(100)
  name: string;

  @ApiProperty({
    example: 'bank',
    enum: CONTAINER_TYPES,
  })
  @IsIn(CONTAINER_TYPES)
  type: (typeof CONTAINER_TYPES)[number];

  @ApiProperty({ example: 25000.5 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Type(() => Number)
  balance: number;

  @ApiProperty({ example: 'INR', enum: SUPPORTED_CURRENCIES })
  @IsString()
  @Length(3, 3)
  @IsIn(SUPPORTED_CURRENCIES)
  currency: string;

  @ApiPropertyOptional({ example: 'HDFC Bank' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  institution?: string;

  @ApiPropertyOptional({ example: '#0072F5' })
  @IsOptional()
  @IsString()
  @Length(4, 7)
  color?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  include_in_net_worth?: boolean;
}
