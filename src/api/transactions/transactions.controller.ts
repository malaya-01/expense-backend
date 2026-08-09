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
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { TransactionsService } from './transactions.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';
import { errorResponse, successResponse } from 'src/utils/response/response';
import { RequirePermissions } from 'src/helper/decorators/permissions.decorator';

@RequirePermissions('expenses.access')
@ApiBearerAuth('bearer')
@ApiTags('transactions')
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a ledger transaction (double-entry)' })
  @ApiBody({ type: CreateTransactionDto })
  @RequirePermissions('expenses.create')
  async create(
    @Body() dto: CreateTransactionDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const userId = req['user'].id as string;
      const result = await this.transactionsService.create(userId, dto);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, 'Transaction recorded.'));
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
  @ApiOperation({ summary: 'List ledger transactions' })
  @RequirePermissions('expenses.read')
  async findAll(@Req() req: Request, @Res() res: Response) {
    try {
      const userId = req['user'].id as string;
      const result = await this.transactionsService.findAll(userId);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, 'Transactions fetched.'));
    } catch (error) {
      const message = error.message || 'An unexpected error occured';
      const statusCode =
        error.statuscode || error.status || HttpStatus.BAD_REQUEST;
      return res
        .status(statusCode)
        .send(errorResponse(message, statusCode, []));
    }
  }

  @Get(':id/journal')
  @ApiOperation({ summary: 'Get immutable journal history for a transaction' })
  @RequirePermissions('expenses.read')
  async findJournal(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const userId = req['user'].id as string;
      const result = await this.transactionsService.findJournal(userId, id);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, 'Journal history fetched.'));
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
  @ApiOperation({ summary: 'Get one ledger transaction' })
  @RequirePermissions('expenses.read')
  async findOne(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const userId = req['user'].id as string;
      const result = await this.transactionsService.findOne(userId, id);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, 'Transaction found.'));
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
  @ApiOperation({ summary: 'Update a ledger transaction (reposts balances)' })
  @RequirePermissions('expenses.update')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateTransactionDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const userId = req['user'].id as string;
      const result = await this.transactionsService.update(userId, id, dto);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, 'Transaction updated.'));
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
  @ApiOperation({ summary: 'Soft-delete and reverse balance effects' })
  @RequirePermissions('expenses.delete')
  async remove(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const userId = req['user'].id as string;
      const result = await this.transactionsService.remove(userId, id);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, 'Transaction deleted.'));
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
