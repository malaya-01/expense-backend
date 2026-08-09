import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export class PermissionOverrideItemDto {
  @ApiProperty({ example: 'ai.access' })
  @IsString()
  code: string;

  @ApiPropertyOptional({
    enum: ['GRANT', 'REVOKE', null],
    description: 'null clears the override and restores catalog default',
    nullable: true,
  })
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsIn(['GRANT', 'REVOKE'])
  effect: 'GRANT' | 'REVOKE' | null;
}

export class UpdateUserPermissionsDto {
  @ApiProperty({ type: [PermissionOverrideItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PermissionOverrideItemDto)
  overrides: PermissionOverrideItemDto[];
}

export class SetUserAdminDto {
  @ApiProperty()
  @IsBoolean()
  is_admin: boolean;
}

export class ListUsersQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  limit?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  offset?: string;
}

export class UserIdParamDto {
  @IsUUID()
  userId: string;
}
