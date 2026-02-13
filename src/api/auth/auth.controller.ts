import { Controller, Get, Post, Body, Patch, Param, Delete, Req, Res } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginAuthDto, PasswordResetDto, RegisterAuthDto } from './dto/create-auth.dto';
// import { UpdateAuthDto } from './dto/update-auth.dto';
import { ApiOperation } from '@nestjs/swagger';
import { OtpGenerateDto } from './dto/generat-otp.dto';
import { Request, Response } from 'express';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @ApiOperation({ summary: 'Register a new user' })
  async registerUser(@Body() registerAuthDto: RegisterAuthDto) {
    return this.authService.register(registerAuthDto);
  }

  @Post('login')
  @ApiOperation({ summary: 'User login' })
  async loginUser(@Body() loginUserDto: LoginAuthDto, @Req() req: Request) {
    return this.authService.login(loginUserDto, req);
  }

  @Post('generate-otp')
  @ApiOperation({ summary: 'Generate OTP for user' })
  async generateOtp(@Body() dto: OtpGenerateDto) {
    return this.authService.generateOtp(dto);
  }

  @Post('reset-password')
  @ApiOperation({ summary: 'Reset user password' })
  async resetPassword(@Body() dto: PasswordResetDto){
    return this.authService.resetPassword(dto);
  }

  @Post('refresh-token')
  @ApiOperation({summary: "Refresh access token using refresh token."})
  async refreshToken(@Req() req: Request, @Res({passthrough: true}) res: Response) {
    return this.authService.refreshToken(req, res);
  }

}
