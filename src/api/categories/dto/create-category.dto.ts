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
import { ApiProperty } from '@nestjs/swagger';

import { Type } from 'class-transformer';

export class CreateCategoryDto {

  // Inject from JWT guard — do NOT trust frontend
  @ApiProperty({
    description: 'User ID (auto-injected from JWT)',
    example: '550e8400-e29b-41d4-a716-446655440000',
    required: false
  })
  @IsOptional()
  @IsUUID()
  user_id?: string;

  @ApiProperty({
    description: 'Category name',
    example: 'Groceries',
    maxLength: 100
  })
  @IsString()
  @MaxLength(100)
  name: string;

  @ApiProperty({
    description: 'Category description',
    example: 'Food and grocery items',
    required: false
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    description: 'HEX color code (4-7 characters)',
    example: '#3B82F6',
    required: false
  })
  @IsOptional()
  @IsString()
  @Length(4, 7)
  color?: string;

  @ApiProperty({
    description: 'Icon identifier',
    example: 'shopping-bag',
    maxLength: 50,
    required: false
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  icon?: string;

  @ApiProperty({
    description: 'Parent category ID (for nested categories)',
    example: '550e8400-e29b-41d4-a716-446655440000',
    required: false
  })
  @IsOptional()
  @IsUUID()
  parent_id?: string;

  @ApiProperty({
    description: 'Whether this is a system category',
    example: false,
    required: false
  })
  @IsOptional()
  @IsBoolean()
  is_system?: boolean;

  @ApiProperty({
    description: 'Budget amount for this category',
    example: 500.00,
    required: false
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Type(() => Number)
  budget_amount?: number;

  @ApiProperty({
    description: 'Budget period (DAILY | WEEKLY | MONTHLY | YEARLY)',
    example: 'MONTHLY',
    maxLength: 20,
    required: false
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  budget_period?: string;
}
