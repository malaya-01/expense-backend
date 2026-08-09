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
import { BudgetsService } from './budgets.service';
import { CreateBudgetDto } from './dto/create-budget.dto';
import { UpdateBudgetDto } from './dto/update-budget.dto';
import { errorResponse, successResponse } from 'src/utils/response/response';
import { RequirePermissions } from 'src/helper/decorators/permissions.decorator';

@RequirePermissions('budgets.access')
@ApiBearerAuth('bearer')
@ApiTags('budgets')
@Controller('budgets')
export class BudgetsController {
  constructor(private readonly budgetsService: BudgetsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a spending budget' })
  @ApiBody({ type: CreateBudgetDto })
  @ApiResponse({ status: 200, description: 'Budget created' })
  @RequirePermissions('budgets.create')
  async create(
    @Body() dto: CreateBudgetDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const userId = req['user'].id as string;
      const result = await this.budgetsService.create(userId, dto);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, 'Budget created.'));
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
  @ApiOperation({ summary: 'List budgets with current-period progress' })
  @RequirePermissions('budgets.read')
  async findAll(@Req() req: Request, @Res() res: Response) {
    try {
      const userId = req['user'].id as string;
      const result = await this.budgetsService.findAll(userId);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, 'Budgets fetched.'));
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
  @ApiOperation({ summary: 'Get one budget with progress' })
  @RequirePermissions('budgets.read')
  async findOne(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const userId = req['user'].id as string;
      const result = await this.budgetsService.findOne(userId, id);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, 'Budget found.'));
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
  @ApiOperation({ summary: 'Update a budget' })
  @RequirePermissions('budgets.update')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateBudgetDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const userId = req['user'].id as string;
      const result = await this.budgetsService.update(userId, id, dto);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, 'Budget updated.'));
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
  @ApiOperation({ summary: 'Soft-delete a budget' })
  @RequirePermissions('budgets.delete')
  async remove(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const userId = req['user'].id as string;
      const result = await this.budgetsService.remove(userId, id);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, 'Budget deleted.'));
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
