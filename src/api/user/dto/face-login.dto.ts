import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  ArrayMaxSize,
  ArrayMinSize,
} from 'class-validator';

export class SaveFaceLoginDto {
  @ApiProperty({ type: [Number] })
  @IsArray()
  @ArrayMinSize(64)
  @ArrayMaxSize(256)
  @IsNumber({}, { each: true })
  descriptor: number[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  preview_base64?: string;
}

export class MatchFaceLoginDto {
  @ApiProperty({ type: [Number] })
  @IsArray()
  @ArrayMinSize(64)
  @ArrayMaxSize(256)
  @IsNumber({}, { each: true })
  descriptor: number[];
}
