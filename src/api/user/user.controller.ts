import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Patch,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
} from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { Request, Response } from 'express';
import { UserService } from './user.service';
import {
  ChangePasswordDto,
  UpdateProfileDto,
} from './dto/update-profile.dto';
import { errorResponse, successResponse } from 'src/utils/response/response';
import { RequirePermissions } from 'src/helper/decorators/permissions.decorator';

@RequirePermissions('settings.access')
@ApiBearerAuth('bearer')
@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get()
  @ApiOperation({ summary: 'Get current user profile' })
  @RequirePermissions('settings.read')
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
  @ApiOperation({ summary: 'Update profile fields' })
  @RequirePermissions('settings.update')
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

  @Post('avatar')
  @ApiOperation({ summary: 'Upload profile avatar image' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        avatar: { type: 'string', format: 'binary' },
      },
      required: ['avatar'],
    },
  })
  @RequirePermissions('settings.update')
  @UseInterceptors(
    FileInterceptor('avatar', {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  )
  async uploadAvatar(
    @Req() req: Request,
    @UploadedFile() file: Express.Multer.File,
    @Res() res: Response,
  ) {
    try {
      const user = await this.userService.uploadAvatar(
        (req as any).user.id as string,
        file,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(user, 'Avatar uploaded'));
    } catch (error) {
      const statusCode = error.status || error.statusCode || HttpStatus.BAD_REQUEST;
      return res
        .status(statusCode)
        .send(errorResponse(error.message || 'Failed to upload avatar', statusCode));
    }
  }

  @Delete('avatar')
  @ApiOperation({ summary: 'Remove profile avatar' })
  @RequirePermissions('settings.update')
  async removeAvatar(@Req() req: Request, @Res() res: Response) {
    try {
      const user = await this.userService.removeAvatar(
        (req as any).user.id as string,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(user, 'Avatar removed'));
    } catch (error) {
      const statusCode = error.status || error.statusCode || HttpStatus.BAD_REQUEST;
      return res
        .status(statusCode)
        .send(errorResponse(error.message || 'Failed to remove avatar', statusCode));
    }
  }

  @Get('notification-preferences')
  @ApiOperation({ summary: 'Get notification preferences including read state' })
  @RequirePermissions('settings.read')
  async getNotificationPreferences(@Req() req: Request, @Res() res: Response) {
    try {
      const data = await this.userService.getNotificationPreferences(
        (req as any).user.id as string,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Notification preferences'));
    } catch (error) {
      const statusCode = error.status || error.statusCode || HttpStatus.BAD_REQUEST;
      return res
        .status(statusCode)
        .send(errorResponse(error.message || 'Failed to load preferences', statusCode));
    }
  }

  @Patch('notification-preferences')
  @ApiOperation({ summary: 'Merge notification preferences' })
  @RequirePermissions('settings.update')
  async saveNotificationPreferences(
    @Req() req: Request,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ) {
    try {
      const data = await this.userService.saveNotificationPreferences(
        (req as any).user.id as string,
        body || {},
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Notification preferences saved'));
    } catch (error) {
      const statusCode = error.status || error.statusCode || HttpStatus.BAD_REQUEST;
      return res
        .status(statusCode)
        .send(errorResponse(error.message || 'Failed to save preferences', statusCode));
    }
  }

  @Patch('password')
  @ApiOperation({ summary: 'Change account password' })
  @RequirePermissions('settings.update')
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
