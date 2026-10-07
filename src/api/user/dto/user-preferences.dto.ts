import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Equals,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export const DATE_FORMATS = [
  'auto',
  'DD/MM/YYYY',
  'MM/DD/YYYY',
  'YYYY-MM-DD',
  'D MMM YYYY',
  'MMM D, YYYY',
] as const;

export const NUMBER_FORMATS = [
  'auto',
  'indian',
  'comma_dot',
  'dot_comma',
  'space_comma',
] as const;

/** 0 = Sunday, 1 = Monday, 6 = Saturday (JS Date#getDay numbering). */
export const WEEK_STARTS = [0, 1, 6] as const;
export const TRANSACTION_TYPES = ['expense', 'income', 'transfer'] as const;
export const DENSITIES = ['comfortable', 'compact'] as const;
export const FONT_SCALE_MIN = 90;
export const FONT_SCALE_MAX = 120;

export type UserPreferences = {
  date_format?: (typeof DATE_FORMATS)[number];
  number_format?: (typeof NUMBER_FORMATS)[number];
  week_start?: (typeof WEEK_STARTS)[number];
  default_account_id?: string | null;
  default_category_id?: string | null;
  default_transaction_type?: (typeof TRANSACTION_TYPES)[number];
  remember_last_account?: boolean;
  confirm_before_delete?: boolean;
  density?: (typeof DENSITIES)[number];
  reduce_motion?: boolean;
  font_scale?: number;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whitelist + type-check a preferences object. Used for payloads that do not
 * pass through the ValidationPipe (offline sync push of `user_settings`).
 * Invalid keys are dropped rather than rejected so one stale field cannot
 * block a queued offline change.
 */
export function sanitizeUserPreferences(input: unknown): UserPreferences {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const raw = input as Record<string, unknown>;
  const out: UserPreferences = {};
  const pick = <T>(list: readonly T[], value: unknown): T | undefined =>
    list.includes(value as T) ? (value as T) : undefined;
  const uuidOrNull = (value: unknown): string | null | undefined => {
    if (value === null || value === '') return null;
    return typeof value === 'string' && UUID_RE.test(value) ? value : undefined;
  };

  const dateFormat = pick(DATE_FORMATS, raw.date_format);
  if (dateFormat) out.date_format = dateFormat;
  const numberFormat = pick(NUMBER_FORMATS, raw.number_format);
  if (numberFormat) out.number_format = numberFormat;
  const weekStart = pick(WEEK_STARTS, Number(raw.week_start));
  if (raw.week_start !== undefined && weekStart !== undefined) {
    out.week_start = weekStart;
  }
  if ('default_account_id' in raw) {
    const id = uuidOrNull(raw.default_account_id);
    if (id !== undefined) out.default_account_id = id;
  }
  if ('default_category_id' in raw) {
    const id = uuidOrNull(raw.default_category_id);
    if (id !== undefined) out.default_category_id = id;
  }
  const txType = pick(TRANSACTION_TYPES, raw.default_transaction_type);
  if (txType) out.default_transaction_type = txType;
  for (const key of [
    'remember_last_account',
    'confirm_before_delete',
    'reduce_motion',
  ] as const) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  }
  const density = pick(DENSITIES, raw.density);
  if (density) out.density = density;
  const scale = Number(raw.font_scale);
  if (
    raw.font_scale !== undefined &&
    Number.isInteger(scale) &&
    scale >= FONT_SCALE_MIN &&
    scale <= FONT_SCALE_MAX
  ) {
    out.font_scale = scale;
  }
  return out;
}

export class UserPreferencesDto {
  @ApiPropertyOptional({ enum: DATE_FORMATS, example: 'DD/MM/YYYY' })
  @IsOptional()
  @IsIn(DATE_FORMATS)
  date_format?: (typeof DATE_FORMATS)[number];

  @ApiPropertyOptional({ enum: NUMBER_FORMATS, example: 'indian' })
  @IsOptional()
  @IsIn(NUMBER_FORMATS)
  number_format?: (typeof NUMBER_FORMATS)[number];

  @ApiPropertyOptional({ enum: WEEK_STARTS, example: 1 })
  @IsOptional()
  @IsInt()
  @IsIn(WEEK_STARTS)
  week_start?: (typeof WEEK_STARTS)[number];

  @ApiPropertyOptional({ nullable: true, format: 'uuid' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  default_account_id?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  default_category_id?: string | null;

  @ApiPropertyOptional({ enum: TRANSACTION_TYPES })
  @IsOptional()
  @IsIn(TRANSACTION_TYPES)
  default_transaction_type?: (typeof TRANSACTION_TYPES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  remember_last_account?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  confirm_before_delete?: boolean;

  @ApiPropertyOptional({ enum: DENSITIES })
  @IsOptional()
  @IsIn(DENSITIES)
  density?: (typeof DENSITIES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  reduce_motion?: boolean;

  @ApiPropertyOptional({ minimum: FONT_SCALE_MIN, maximum: FONT_SCALE_MAX })
  @IsOptional()
  @IsInt()
  @Min(FONT_SCALE_MIN)
  @Max(FONT_SCALE_MAX)
  font_scale?: number;
}

export class RevokeOtherSessionsDto {
  @ApiPropertyOptional({
    description:
      'Refresh token of this device (native clients). Web clients may rely on the refresh cookie.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  refreshToken?: string;
}

export class DeleteAccountDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  password!: string;

  @ApiProperty({ example: 'DELETE' })
  @IsString()
  @Equals('DELETE', { message: 'Type DELETE to confirm' })
  confirmation!: string;
}
