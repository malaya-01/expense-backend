import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Length, Matches } from 'class-validator';

export class VerifyRecoveryOtpDto {
  @ApiProperty({
    example: 'user@example.com',
    description: 'Account email',
  })
  @IsEmail()
  email: string;

  @ApiProperty({
    example: '123456',
    description: '6-digit recovery code',
  })
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/)
  otp: string;
}
