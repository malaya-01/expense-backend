import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
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
import { UpdateThemePreferencesDto } from './dto/theme-preferences.dto';
import {
  DeleteAccountDto,
  RevokeOtherSessionsDto,
  UserPreferencesDto,
} from './dto/user-preferences.dto';
import {
  REFRESH_COOKIE_NAME,
  clearRefreshCookieOptions,
  readPresentedRefreshToken,
} from 'src/api/auth/refresh-cookie';
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

  @Get('theme-preferences')
  @ApiOperation({ summary: 'Get saved UI theme preference' })
  @RequirePermissions('dashboard.access')
  async getThemePreferences(@Req() req: Request, @Res() res: Response) {
    try {
      const data = await this.userService.getThemePreferences(
        (req as any).user.id as string,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Theme preferences'));
    } catch (error) {
      const statusCode = error.status || error.statusCode || HttpStatus.BAD_REQUEST;
      return res
        .status(statusCode)
        .send(errorResponse(error.message || 'Failed to load theme', statusCode));
    }
  }

  @Put('theme-preferences')
  @ApiOperation({ summary: 'Save UI theme preference (active theme + customs)' })
  @RequirePermissions('dashboard.access')
  async saveThemePreferences(
    @Req() req: Request,
    @Body() dto: UpdateThemePreferencesDto,
    @Res() res: Response,
  ) {
    try {
      const data = await this.userService.saveThemePreferences(
        (req as any).user.id as string,
        dto,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Theme preferences saved'));
    } catch (error) {
      const statusCode = error.status || error.statusCode || HttpStatus.BAD_REQUEST;
      return res
        .status(statusCode)
        .send(errorResponse(error.message || 'Failed to save theme', statusCode));
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

  @Get('preferences')
  @ApiOperation({ summary: 'Get app preferences (formats, defaults, appearance)' })
  @RequirePermissions('dashboard.access')
  async getPreferences(@Req() req: Request, @Res() res: Response) {
    try {
      const data = await this.userService.getPreferences(
        (req as any).user.id as string,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Preferences'));
    } catch (error) {
      const statusCode = error.status || error.statusCode || HttpStatus.BAD_REQUEST;
      return res
        .status(statusCode)
        .send(errorResponse(error.message || 'Failed to load preferences', statusCode));
    }
  }

  @Patch('preferences')
  @ApiOperation({ summary: 'Merge app preferences' })
  @RequirePermissions('dashboard.access')
  async updatePreferences(
    @Req() req: Request,
    @Body() dto: UserPreferencesDto,
    @Res() res: Response,
  ) {
    try {
      const data = await this.userService.updatePreferences(
        (req as any).user.id as string,
        dto,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Preferences saved'));
    } catch (error) {
      const statusCode = error.status || error.statusCode || HttpStatus.BAD_REQUEST;
      return res
        .status(statusCode)
        .send(errorResponse(error.message || 'Failed to save preferences', statusCode));
    }
  }

  @Get('sessions')
  @ApiOperation({
    summary: 'List active sign-in sessions',
    description:
      'Pass `current` (SHA-256 hex of this device refresh token) to flag the current session.',
  })
  @RequirePermissions('settings.read')
  async listSessions(
    @Req() req: Request,
    @Query('current') current: string | undefined,
    @Res() res: Response,
  ) {
    try {
      const data = await this.userService.listSessions(
        (req as any).user.id as string,
        typeof current === 'string' ? current : null,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Sessions'));
    } catch (error) {
      const statusCode = error.status || error.statusCode || HttpStatus.BAD_REQUEST;
      return res
        .status(statusCode)
        .send(errorResponse(error.message || 'Failed to load sessions', statusCode));
    }
  }

  @Post('sessions/revoke-others')
  @ApiOperation({ summary: 'Sign out of every other device' })
  @RequirePermissions('settings.update')
  async revokeOtherSessions(
    @Req() req: Request,
    @Body() _dto: RevokeOtherSessionsDto,
    @Res() res: Response,
  ) {
    try {
      const data = await this.userService.revokeOtherSessions(
        (req as any).user.id as string,
        readPresentedRefreshToken(req),
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Other sessions signed out'));
    } catch (error) {
      const statusCode = error.status || error.statusCode || HttpStatus.BAD_REQUEST;
      return res
        .status(statusCode)
        .send(errorResponse(error.message || 'Failed to sign out other sessions', statusCode));
    }
  }

  @Delete('sessions/:id')
  @ApiOperation({ summary: 'Revoke one sign-in session' })
  @RequirePermissions('settings.update')
  async revokeSession(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res() res: Response,
  ) {
    try {
      const data = await this.userService.revokeSession(
        (req as any).user.id as string,
        id,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Session revoked'));
    } catch (error) {
      const statusCode = error.status || error.statusCode || HttpStatus.BAD_REQUEST;
      return res
        .status(statusCode)
        .send(errorResponse(error.message || 'Failed to revoke session', statusCode));
    }
  }

  @Post('delete-account')
  @ApiOperation({
    summary: 'Delete (soft) the account',
    description:
      'Requires the current password and confirmation "DELETE". Marks the user deleted and revokes all sessions.',
  })
  @RequirePermissions('settings.update')
  async deleteAccount(
    @Req() req: Request,
    @Body() dto: DeleteAccountDto,
    @Res() res: Response,
  ) {
    try {
      const data = await this.userService.deleteAccount(
        (req as any).user.id as string,
        dto,
      );
      res.clearCookie(REFRESH_COOKIE_NAME, clearRefreshCookieOptions());
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Account deleted'));
    } catch (error) {
      const statusCode = error.status || error.statusCode || HttpStatus.BAD_REQUEST;
      return res
        .status(statusCode)
        .send(errorResponse(error.message || 'Failed to delete account', statusCode));
    }
  }
}
