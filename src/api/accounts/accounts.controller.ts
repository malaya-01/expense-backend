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
import { AccountsService } from './accounts.service';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import { errorResponse, successResponse } from 'src/utils/response/response';

@ApiBearerAuth('bearer')
@ApiTags('accounts')
@Controller('accounts')
export class AccountsController {
  constructor(private readonly accountsService: AccountsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a financial container' })
  @ApiBody({ type: CreateAccountDto })
  @ApiResponse({ status: 200, description: 'Container created' })
  async create(
    @Body() dto: CreateAccountDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const userId = req['user'].id as string;
      const result = await this.accountsService.create(userId, dto);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, 'Financial container created.'));
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
  @ApiOperation({ summary: 'List financial containers for the current user' })
  async findAll(@Req() req: Request, @Res() res: Response) {
    try {
      const userId = req['user'].id as string;
      const result = await this.accountsService.findAll(userId);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, 'Financial containers fetched.'));
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
  @ApiOperation({ summary: 'Get one financial container' })
  async findOne(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const userId = req['user'].id as string;
      const result = await this.accountsService.findOne(userId, id);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, 'Financial container found.'));
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
  @ApiOperation({ summary: 'Update a financial container' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateAccountDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const userId = req['user'].id as string;
      const result = await this.accountsService.update(userId, id, dto);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, 'Financial container updated.'));
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
  @ApiOperation({ summary: 'Soft-delete a financial container' })
  async remove(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const userId = req['user'].id as string;
      const result = await this.accountsService.remove(userId, id);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, 'Financial container deleted.'));
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
