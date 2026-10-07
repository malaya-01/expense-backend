import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  COUNTRIES,
  SUPPORTED_CURRENCIES,
} from 'src/common/currency/currency.data';
import { UserPreferencesDto } from './user-preferences.dto';

const COUNTRY_CODES = COUNTRIES.map((c) => c.code);

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Jane Doe' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  full_name?: string;

  @ApiPropertyOptional({ example: 'IN', enum: COUNTRY_CODES })
  @IsOptional()
  @IsString()
  @Length(2, 2)
  @IsIn(COUNTRY_CODES)
  country?: string;

  @ApiPropertyOptional({ example: 'INR', enum: SUPPORTED_CURRENCIES })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  @IsIn(SUPPORTED_CURRENCIES)
  currency?: string;

  @ApiPropertyOptional({ example: 'Asia/Kolkata' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  timezone?: string;

  @ApiPropertyOptional({ example: 'en-US' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  locale?: string;

  @ApiPropertyOptional({ type: UserPreferencesDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => UserPreferencesDto)
  preferences?: UserPreferencesDto;
}

export class ChangePasswordDto {
  @ApiPropertyOptional()
  @IsString()
  @MinLength(8)
  currentPassword: string;

  @ApiPropertyOptional()
  @IsString()
  @MinLength(8)
  newPassword: string;

  @ApiPropertyOptional()
  @IsString()
  @MinLength(8)
  confirmNewPassword: string;
}
