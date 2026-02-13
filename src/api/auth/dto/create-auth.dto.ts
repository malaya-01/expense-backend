import { ApiProperty } from "@nestjs/swagger";
import { IsEmail, IsString, MinLength } from "class-validator";

// export class CreateAuthDto {}

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