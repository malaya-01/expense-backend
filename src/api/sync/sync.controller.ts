import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Req,
  Res,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Request as ExpressRequest, Response } from 'express';
import { SyncService } from './sync.service';
import { SyncPushDto } from './dto/sync.dto';
import { errorResponse, successResponse } from 'src/utils/response/response';
import { RequirePermissions } from 'src/helper/decorators/permissions.decorator';

@RequirePermissions('sync.access')
@ApiBearerAuth('bearer')
@ApiTags('sync')
@Controller('sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Get('status')
  @ApiOperation({ summary: 'Sync status and server time' })
  @RequirePermissions('sync.read')
  async status(@Req() req: ExpressRequest, @Res() res: Response) {
    try {
      const data = await this.syncService.status(req['user'].id);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Sync status loaded.'));
    } catch (error: any) {
      return res
        .status(error.status || HttpStatus.BAD_REQUEST)
        .send(errorResponse(error.message, error.status || 400));
    }
  }

  @Post('push')
  @ApiOperation({ summary: 'Push offline outbox changes' })
  @RequirePermissions('sync.create')
  async push(
    @Req() req: ExpressRequest,
    @Res() res: Response,
    @Body() dto: SyncPushDto,
  ) {
    try {
      const data = await this.syncService.push(req['user'].id, dto);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Sync push completed.'));
    } catch (error: any) {
      return res
        .status(error.status || HttpStatus.BAD_REQUEST)
        .send(errorResponse(error.message, error.status || 400));
    }
  }

  @Get('pull')
  @ApiOperation({ summary: 'Pull incremental changes since cursor' })
  @RequirePermissions('sync.read')
  async pull(
    @Req() req: ExpressRequest,
    @Res() res: Response,
    @Query('since') since?: string,
    @Query('device_id') deviceId?: string,
  ) {
    try {
      const data = await this.syncService.pull(
        req['user'].id,
        since,
        deviceId || 'unknown',
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Sync pull completed.'));
    } catch (error: any) {
      return res
        .status(error.status || HttpStatus.BAD_REQUEST)
        .send(errorResponse(error.message, error.status || 400));
    }
  }
}
