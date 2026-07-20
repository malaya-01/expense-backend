import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export const TRANSACTION_TYPES = ['expense', 'income', 'transfer'] as const;

export class CreateTransactionDto {
  @ApiProperty({ enum: TRANSACTION_TYPES, example: 'expense' })
  @IsIn(TRANSACTION_TYPES)
  type: (typeof TRANSACTION_TYPES)[number];

  @ApiProperty({ example: 42.5 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Type(() => Number)
  amount: number;

  @ApiProperty({ example: 'Groceries at FreshMart' })
  @IsString()
  @MaxLength(500)
  description: string;

  @ApiProperty({ example: '2026-07-20' })
  @IsDateString()
  date: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  category_id?: string;

  @ApiPropertyOptional({
    description: 'Required for expense and transfer (money leaves here)',
  })
  @IsOptional()
  @IsUUID()
  source_container_id?: string;

  @ApiPropertyOptional({
    description: 'Required for income and transfer (money arrives here)',
  })
  @IsOptional()
  @IsUUID()
  destination_container_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  merchant?: string;

  @ApiPropertyOptional({ example: 'USD' })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @ApiPropertyOptional({
    description:
      'For cross-currency transfers: destination units received per 1 source unit. Auto-filled from FX rates when omitted.',
    example: 83.5,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 8 })
  @IsPositive()
  @Type(() => Number)
  exchange_rate?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
