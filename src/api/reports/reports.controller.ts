import {
  Body,
  Controller,
  Get,
  Post,
  Patch,
  Query,
  Req,
  Res,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { ReportsService } from './reports.service';
import { ReportDispatchService } from './report-dispatch.service';
import { UpdateReportScheduleDto } from './dto/report-schedule.dto';
import { errorResponse, successResponse } from 'src/utils/response/response';
import { RequirePermissions } from 'src/helper/decorators/permissions.decorator';

@RequirePermissions('reports.access')
@ApiBearerAuth('bearer')
@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly reportDispatch: ReportDispatchService,
  ) {}

  @Get('overview')
  @ApiOperation({
    summary:
      'Financial overview: twin, cash flow, categories, budgets, investments',
  })
  @RequirePermissions('reports.read')
  @ApiQuery({ name: 'months', required: false, example: 6 })
  async overview(
    @Query('months') months: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const userId = req['user'].id as string;
      const result = await this.reportsService.overview(
        userId,
        months ? Number(months) : 6,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, 'Report overview ready.'));
    } catch (error) {
      const message = error.message || 'An unexpected error occured';
      const statusCode =
        error.statuscode || error.status || HttpStatus.BAD_REQUEST;
      return res
        .status(statusCode)
        .send(errorResponse(message, statusCode, []));
    }
  }

  @Get('schedule')
  @ApiOperation({
    summary:
      'Email report cadence. Default is weekly Saturday 10:00 in the user timezone.',
  })
  @RequirePermissions('reports.read')
  async getSchedule(@Req() req: Request, @Res() res: Response) {
    try {
      const userId = req['user'].id as string;
      const result = await this.reportDispatch.getSchedule(userId);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, 'Report schedule loaded.'));
    } catch (error) {
      const message = error.message || 'An unexpected error occured';
      const statusCode =
        error.statuscode || error.status || HttpStatus.BAD_REQUEST;
      return res
        .status(statusCode)
        .send(errorResponse(message, statusCode, []));
    }
  }

  @Patch('schedule')
  @ApiOperation({ summary: 'Update email report frequency, dates, and time' })
  @RequirePermissions('reports.update')
  async saveSchedule(
    @Req() req: Request,
    @Body() dto: UpdateReportScheduleDto,
    @Res() res: Response,
  ) {
    try {
      const userId = req['user'].id as string;
      const result = await this.reportDispatch.saveSchedule(userId, dto);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, 'Report schedule saved.'));
    } catch (error) {
      const message = error.message || 'An unexpected error occured';
      const statusCode =
        error.statuscode || error.status || HttpStatus.BAD_REQUEST;
      return res
        .status(statusCode)
        .send(errorResponse(message, statusCode, []));
    }
  }

  @Post('schedule/send-now')
  @ApiOperation({
    summary: 'Email the current period report immediately (HTML + Excel)',
  })
  @RequirePermissions('reports.update')
  async sendNow(@Req() req: Request, @Res() res: Response) {
    try {
      const userId = req['user'].id as string;
      const result = await this.reportDispatch.sendNow(userId);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, 'Report queued to your email.'));
    } catch (error) {
      const message = error.message || 'An unexpected error occured';
      const statusCode =
        error.statuscode || error.status || HttpStatus.BAD_REQUEST;
      return res
        .status(statusCode)
        .send(errorResponse(message, statusCode, []));
    }
  }
}
