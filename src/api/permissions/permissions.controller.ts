import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { RequireAnyPermission, RequirePermissions } from 'src/helper/decorators/permissions.decorator';
import { PERMISSION_CODES } from './permission.codes';
import { PermissionsService } from './permissions.service';
import {
  ListUsersQueryDto,
  SetUserAdminDto,
  UpdateUserPermissionsDto,
} from './dto/permissions.dto';
import { errorResponse, successResponse } from 'src/utils/response/response';

@ApiBearerAuth('bearer')
@ApiTags('permissions')
@Controller('permissions')
export class PermissionsController {
  constructor(private readonly permissionsService: PermissionsService) {}

  @Get('me')
  @ApiOperation({ summary: 'Effective permissions for the current user' })
  async me(@Req() req: Request, @Res() res: Response) {
    try {
      const data = await this.permissionsService.mePayload(
        (req as any).user.id as string,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Permissions loaded'));
    } catch (error: any) {
      return res
        .status(error.status || HttpStatus.BAD_REQUEST)
        .send(errorResponse(error.message, error.status || 400));
    }
  }

  @Get()
  @RequirePermissions(PERMISSION_CODES.ADMIN_MANAGE_PERMISSIONS)
  @ApiOperation({ summary: 'List permission catalog' })
  async catalog(@Res() res: Response) {
    try {
      const data = await this.permissionsService.listCatalog();
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Permission catalog loaded'));
    } catch (error: any) {
      return res
        .status(error.status || HttpStatus.BAD_REQUEST)
        .send(errorResponse(error.message, error.status || 400));
    }
  }

  @Get('users')
  @RequireAnyPermission(
    PERMISSION_CODES.ADMIN_MANAGE_USERS,
    PERMISSION_CODES.ADMIN_MANAGE_PERMISSIONS,
  )
  @ApiOperation({ summary: 'List users for admin permission management' })
  async listUsers(@Query() query: ListUsersQueryDto, @Res() res: Response) {
    try {
      const data = await this.permissionsService.listUsers(
        query.q,
        query.limit ? Number(query.limit) : 50,
        query.offset ? Number(query.offset) : 0,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Users loaded'));
    } catch (error: any) {
      return res
        .status(error.status || HttpStatus.BAD_REQUEST)
        .send(errorResponse(error.message, error.status || 400));
    }
  }

  @Get('users/:userId')
  @RequireAnyPermission(
    PERMISSION_CODES.ADMIN_MANAGE_USERS,
    PERMISSION_CODES.ADMIN_MANAGE_PERMISSIONS,
  )
  @ApiOperation({ summary: 'Get a user permission matrix' })
  async getUser(
    @Param('userId') userId: string,
    @Res() res: Response,
  ) {
    try {
      const data = await this.permissionsService.getUserPermissions(userId);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'User permissions loaded'));
    } catch (error: any) {
      return res
        .status(error.status || HttpStatus.BAD_REQUEST)
        .send(errorResponse(error.message, error.status || 400));
    }
  }

  @Put('users/:userId')
  @RequirePermissions(PERMISSION_CODES.ADMIN_MANAGE_PERMISSIONS)
  @ApiOperation({ summary: 'Update permission overrides for a user' })
  async updateUser(
    @Param('userId') userId: string,
    @Body() dto: UpdateUserPermissionsDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const data = await this.permissionsService.updateUserPermissions(
        (req as any).user.id as string,
        userId,
        dto,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Permissions updated'));
    } catch (error: any) {
      return res
        .status(error.status || HttpStatus.BAD_REQUEST)
        .send(errorResponse(error.message, error.status || 400));
    }
  }

  @Patch('users/:userId/admin')
  @ApiOperation({
    summary: 'Set or clear super-admin flag (super-admins only)',
  })
  async setAdmin(
    @Param('userId') userId: string,
    @Body() dto: SetUserAdminDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const data = await this.permissionsService.setUserAdmin(
        (req as any).user.id as string,
        userId,
        dto.is_admin,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Admin flag updated'));
    } catch (error: any) {
      return res
        .status(error.status || HttpStatus.BAD_REQUEST)
        .send(errorResponse(error.message, error.status || 400));
    }
  }

  @Post('bootstrap-admins')
  @ApiOperation({
    summary: 'Apply ADMIN_EMAILS bootstrap (super-admin only)',
  })
  async bootstrap(@Req() req: Request, @Res() res: Response) {
    try {
      const actorId = (req as any).user.id as string;
      const isAdmin = await this.permissionsService.getUserAdminFlag(actorId);
      if (!isAdmin) {
        return res
          .status(HttpStatus.FORBIDDEN)
          .send(errorResponse('Only super-admins can bootstrap admins', 403));
      }
      const data = await this.permissionsService.bootstrapAdminsFromEnv();
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Admin bootstrap completed'));
    } catch (error: any) {
      return res
        .status(error.status || HttpStatus.BAD_REQUEST)
        .send(errorResponse(error.message, error.status || 400));
    }
  }
}
