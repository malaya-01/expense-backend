import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Req,
  Res,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { InvestmentsService } from './investments.service';
import { CreateInvestmentDto } from './dto/create-investment.dto';
import { UpdateInvestmentDto } from './dto/update-investment.dto';
import { errorResponse, successResponse } from 'src/utils/response/response';
import { RequirePermissions } from 'src/helper/decorators/permissions.decorator';

@RequirePermissions('investments.access')
@ApiBearerAuth('bearer')
@ApiTags('investments')
@Controller('investments')
export class InvestmentsController {
  constructor(private readonly investmentsService: InvestmentsService) {}

  @Post()
  @ApiOperation({ summary: 'Create an investment holding' })
  @ApiBody({ type: CreateInvestmentDto })
  @ApiResponse({ status: 200, description: 'Holding created' })
  @RequirePermissions('investments.create')
  async create(
    @Body() dto: CreateInvestmentDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const userId = req['user'].id as string;
      const result = await this.investmentsService.create(userId, dto);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, 'Holding created.'));
    } catch (error) {
      const message = error.message || 'An unexpected error occured';
      const statusCode =
        error.statuscode || error.status || HttpStatus.BAD_REQUEST;
      return res
        .status(statusCode)
        .send(errorResponse(message, statusCode, []));
    }
  }

  @Get()
  @ApiOperation({ summary: 'List holdings with portfolio summary' })
  @RequirePermissions('investments.read')
  async findAll(@Req() req: Request, @Res() res: Response) {
    try {
      const userId = req['user'].id as string;
      const result = await this.investmentsService.findAll(userId);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, 'Investments fetched.'));
    } catch (error) {
      const message = error.message || 'An unexpected error occured';
      const statusCode =
        error.statuscode || error.status || HttpStatus.BAD_REQUEST;
      return res
        .status(statusCode)
        .send(errorResponse(message, statusCode, []));
    }
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one holding' })
  @RequirePermissions('investments.read')
  async findOne(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const userId = req['user'].id as string;
      const result = await this.investmentsService.findOne(userId, id);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, 'Holding found.'));
    } catch (error) {
      const message = error.message || 'An unexpected error occured';
      const statusCode =
        error.statuscode || error.status || HttpStatus.BAD_REQUEST;
      return res
        .status(statusCode)
        .send(errorResponse(message, statusCode, []));
    }
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a holding' })
  @RequirePermissions('investments.update')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateInvestmentDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const userId = req['user'].id as string;
      const result = await this.investmentsService.update(userId, id, dto);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, 'Holding updated.'));
    } catch (error) {
      const message = error.message || 'An unexpected error occured';
      const statusCode =
        error.statuscode || error.status || HttpStatus.BAD_REQUEST;
      return res
        .status(statusCode)
        .send(errorResponse(message, statusCode, []));
    }
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete a holding' })
  @RequirePermissions('investments.delete')
  async remove(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const userId = req['user'].id as string;
      const result = await this.investmentsService.remove(userId, id);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, 'Holding deleted.'));
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
