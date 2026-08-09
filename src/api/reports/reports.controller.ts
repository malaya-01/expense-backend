import {
  Controller,
  Get,
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
import { errorResponse, successResponse } from 'src/utils/response/response';
import { RequirePermissions } from 'src/helper/decorators/permissions.decorator';

@RequirePermissions('reports.access')
@ApiBearerAuth('bearer')
@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

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
}
