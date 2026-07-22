import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Patch,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { UserService } from './user.service';
import {
  ChangePasswordDto,
  UpdateProfileDto,
} from './dto/update-profile.dto';
import { errorResponse, successResponse } from 'src/utils/response/response';

@ApiBearerAuth('bearer')
@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get()
  @ApiOperation({ summary: 'Get current user profile' })
  async findCurrent(@Req() req: Request, @Res() res: Response) {
    try {
      const user = await this.userService.findOne((req as any).user.id as string);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(user, 'User profile retrieved'));
    } catch (error) {
      const statusCode = error.status || error.statusCode || HttpStatus.BAD_REQUEST;
      return res
        .status(statusCode)
        .send(errorResponse(error.message || 'Failed to load profile', statusCode));
    }
  }

  @Patch('profile')
  @ApiOperation({ summary: 'Update profile fields and avatar' })
  async updateProfile(
    @Req() req: Request,
    @Body() dto: UpdateProfileDto,
    @Res() res: Response,
  ) {
    try {
      const user = await this.userService.updateProfile(
        (req as any).user.id as string,
        dto,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(user, 'Profile updated'));
    } catch (error) {
      const statusCode = error.status || error.statusCode || HttpStatus.BAD_REQUEST;
      return res
        .status(statusCode)
        .send(errorResponse(error.message || 'Failed to update profile', statusCode));
    }
  }

  @Patch('password')
  @ApiOperation({ summary: 'Change account password' })
  async changePassword(
    @Req() req: Request,
    @Body() dto: ChangePasswordDto,
    @Res() res: Response,
  ) {
    try {
      const result = await this.userService.changePassword(
        (req as any).user.id as string,
        dto,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, result.message));
    } catch (error) {
      const statusCode = error.status || error.statusCode || HttpStatus.BAD_REQUEST;
      return res
        .status(statusCode)
        .send(errorResponse(error.message || 'Failed to change password', statusCode));
    }
  }
}
