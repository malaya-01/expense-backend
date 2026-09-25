import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateReportScheduleDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsIn(['weekly', 'monthly', 'custom'])
  frequency?: 'weekly' | 'monthly' | 'custom';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(6)
  weekday?: number;

  @IsOptional()
  @IsIn(['last_day', 'day_of_month'])
  monthly_mode?: 'last_day' | 'day_of_month';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(28)
  day_of_month?: number;

  @IsOptional()
  @IsIn(['interval', 'dates'])
  custom_mode?: 'interval' | 'dates';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  interval_days?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  @MaxLength(10, { each: true })
  custom_dates?: string[];

  @IsOptional()
  @Matches(/^\d{1,2}:\d{2}(:\d{2})?$/)
  send_time?: string;

  @IsOptional()
  @IsBoolean()
  include_excel?: boolean;

  @IsOptional()
  @IsBoolean()
  include_ai?: boolean;
}
