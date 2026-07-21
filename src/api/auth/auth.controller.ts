import { Controller, Get, Post, Body, Patch, Param, Delete, Req, Res, HttpStatus } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginAuthDto, PasswordResetDto, RegisterAuthDto } from './dto/create-auth.dto';
// import { UpdateAuthDto } from './dto/update-auth.dto';
import { ApiOperation } from '@nestjs/swagger';
import { OtpGenerateDto } from './dto/generat-otp.dto';
import { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { errorResponse, successResponse } from 'src/utils/response/response';
import { Public } from 'src/helper/decorators/public.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('register')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiOperation({ summary: 'Register a new user' })
  async registerUser(@Body() registerAuthDto: RegisterAuthDto,@Res() res: Response) {
    try{
      const result = await this.authService.register(registerAuthDto);
      return res.status(HttpStatus.OK).send(successResponse(result, 'User Registered successfully'));
    }catch(error){
      const statusCode = error.status || error.statusCode || HttpStatus.BAD_REQUEST
      const message = error.message || 'An unexpected error occured.'
      return res.status(statusCode).send(errorResponse(message, statusCode))
    }

  }

  @Public()
  @Post('login')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'User login' })
  async loginUser(@Body() loginUserDto: LoginAuthDto, @Req() req: Request, @Res() res: Response) {
    // return this.authService.login(loginUserDto, req);
    try{
      const result = await this.authService.login(loginUserDto, req)
      res.cookie('refreshToken', result.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
      return res.status(HttpStatus.OK).send(successResponse(result, 'User loged in successfully.'))
    }catch(error){
      const message = error.message || 'An unexpected error occured'
      const statusCode = error.statuscode || error.status || HttpStatus.BAD_REQUEST
      return res.status(statusCode).send(errorResponse(message, statusCode))
    }
  }

  @Public()
  @Post('generate-otp')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiOperation({ summary: 'Generate OTP for user' })
  async generateOtp(@Body() dto: OtpGenerateDto, @Res() res: Response) {
    // return this.authService.generateOtp(dto);
    try{
      const result = await this.authService.generateOtp(dto)
      return res.status(HttpStatus.OK).send(successResponse(result, 'User loged in successfully.'))
    }catch(error){
      const message = error.message || 'An unexpected error occured'
      const statusCode = error.statuscode || error.status || HttpStatus.BAD_REQUEST
      return res.status(statusCode).send(errorResponse(message, statusCode))
    }
  }

  @Public()
  @Post('reset-password')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Reset user password' })
  async resetPassword(@Body() dto: PasswordResetDto, @Res() res: Response){
    // return this.authService.resetPassword(dto);
    try{
      const result = await this.authService.resetPassword(dto)
      return res.status(HttpStatus.OK).send(successResponse(result, 'User loged in successfully.'))
    }catch(error){
      const message = error.message || 'An unexpected error occured'
      const statusCode = error.statuscode || error.status || HttpStatus.BAD_REQUEST
      return res.status(statusCode).send(errorResponse(message, statusCode))
    }
  }

  @Public()
  @Post('refresh-token')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({summary: "Refresh access token using refresh token."})
  async refreshToken(@Req() req: Request, @Res({passthrough: true}) res: Response) {
    // return this.authService.refreshToken(req, res);
    try{
      const result = await this.authService.refreshToken(req, res)
      return res.status(HttpStatus.OK).send(successResponse(result, 'User loged in successfully.'))
    }catch(error){
      const message = error.message || 'An unexpected error occured'
      const statusCode = error.statuscode || error.status || HttpStatus.BAD_REQUEST
      return res.status(statusCode).send(errorResponse(message, statusCode))
    }
  }

}
