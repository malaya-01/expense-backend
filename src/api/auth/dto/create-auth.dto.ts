import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEmail, IsIn, IsOptional, IsString, Length, MinLength } from "class-validator";
import { COUNTRIES, SUPPORTED_CURRENCIES } from "src/common/currency/currency.data";

const COUNTRY_CODES = COUNTRIES.map((c) => c.code);

export class RegisterAuthDto {

    @ApiProperty({
        description: 'Full name of the user',
        example: 'Jhon Doe'
    })
    @IsString()
    full_name: string;

    @ApiProperty({
        description: 'User email',
        example: 'user@example.com'
    })
    @IsEmail()
    email: string;

    @ApiProperty({
        description: 'User password',
        example: 'password123'
    })
    @IsString()
    @MinLength(8)
    password: string;

    @ApiProperty({
        description: 'Confirm password',
        example: 'password123'
    })
    @IsString()
    @MinLength(8)
    confirmPassword: string;

    @ApiProperty({
        description: 'ISO country code',
        example: 'IN',
        enum: COUNTRY_CODES,
    })
    @IsString()
    @Length(2, 2)
    @IsIn(COUNTRY_CODES)
    country: string;

    @ApiPropertyOptional({
        description: 'Base / reporting currency (defaults from country)',
        example: 'INR',
        enum: SUPPORTED_CURRENCIES,
    })
    @IsOptional()
    @IsString()
    @Length(3, 3)
    @IsIn(SUPPORTED_CURRENCIES)
    currency?: string;
}

export class LoginAuthDto {
    @ApiProperty({
        description: 'User email',
        example: 'user@example.com'
    })
    @IsEmail()
    email: string;

    @ApiProperty({
        description: 'User password',
        example: 'password123'
    })
    @IsString()
    @MinLength(8)
    password: string;
}


// Passworord reset DTO
export class PasswordResetDto {
    @ApiProperty({
        description: 'User email',
        example: 'user@example.com'
    })
    @IsEmail()
    email: string;


    @ApiProperty({
        description: 'New password for the user',
        example: 'newpassword123'
    })
    @IsString()
    @MinLength(8)
    newPassword: string;

    @ApiProperty({
        description: 'Confirm new password',
        example: 'newpassword123'
    })
    @IsString()
    @MinLength(8)
    confirmNewPassword: string;

    @ApiProperty({
        description: 'OTP code sent to user email',
        example: '123456'
    })
    @IsString()
    otp: string;
}