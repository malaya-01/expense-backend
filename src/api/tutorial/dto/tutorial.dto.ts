import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export const TUTORIAL_EVENTS = ['view', 'dismiss', 'complete'] as const;
export type TutorialEvent = (typeof TUTORIAL_EVENTS)[number];

export class TutorialProgressDto {
  @ApiProperty({
    enum: TUTORIAL_EVENTS,
    description:
      'view: a step was shown. dismiss: "Skip for now" (shown again next sign-in). complete: finished or marked done.',
  })
  @IsIn(TUTORIAL_EVENTS)
  event!: TutorialEvent;

  @ApiPropertyOptional({ example: 'accounts' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z0-9-]+$/)
  step_id?: string;

  @ApiPropertyOptional({
    example: 'native-android',
    description: 'Client platform code (see frontend runtime-platform).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Matches(/^[a-z0-9-]+$/)
  platform?: string;
}
