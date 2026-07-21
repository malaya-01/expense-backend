import { PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateLoanDto {
  @IsUUID()
  container_id: string;

  @IsString()
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  lender?: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  principal: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  annual_interest_rate: number;

  @IsOptional()
  @IsIn(['fixed', 'floating', 'simple', 'compound'])
  interest_type?: 'fixed' | 'floating' | 'simple' | 'compound';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1200)
  term_months: number;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  start_date: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(31)
  payment_day?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class UpdateLoanDto extends PartialType(CreateLoanDto) {
  @IsOptional()
  @IsIn(['active', 'paused', 'closed', 'archived'])
  status?: 'active' | 'paused' | 'closed' | 'archived';
}

export class RecordLoanPaymentDto {
  @IsUUID()
  source_container_id: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount: number;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.000001)
  exchange_rate?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
