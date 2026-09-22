import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class ThemeTokensDto {
  @IsString()
  background100!: string;

  @IsString()
  background200!: string;

  @IsString()
  backgroundElevated!: string;

  @IsString()
  gray100!: string;

  @IsString()
  gray1000!: string;

  @IsString()
  gray900!: string;

  @IsString()
  gray700!: string;

  @IsString()
  focusColor!: string;

  @IsOptional()
  @IsString()
  linkColor?: string;

  @IsOptional()
  @IsString()
  linkHover?: string;

  @IsOptional()
  @IsString()
  focusInput?: string;

  @IsOptional()
  @IsString()
  focusRingInner?: string;

  @IsOptional()
  @IsString()
  primaryHover?: string;

  @IsOptional()
  @IsString()
  primaryForeground?: string;

  @IsOptional()
  @IsString()
  dangerHover?: string;

  @IsOptional()
  @IsString()
  shadowAlpha?: string;

  @IsOptional()
  @IsString()
  headerBorderAlpha?: string;

  @IsOptional()
  @IsString()
  selectionAlpha?: string;
}

export class CustomThemeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  id!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  description?: string;

  @IsObject()
  @ValidateNested()
  @Type(() => ThemeTokensDto)
  tokens!: ThemeTokensDto;

  @IsOptional()
  builtin?: boolean;
}

export class UpdateThemePreferencesDto {
  @ApiProperty({ example: 'preset:vercel-light' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  active_theme_id!: string;

  @ApiPropertyOptional({ type: [CustomThemeDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomThemeDto)
  custom_themes?: CustomThemeDto[];
}
