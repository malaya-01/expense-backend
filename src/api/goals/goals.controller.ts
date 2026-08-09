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
import { GoalsService } from './goals.service';
import { CreateGoalDto } from './dto/create-goal.dto';
import { ContributeGoalDto, UpdateGoalDto } from './dto/update-goal.dto';
import { errorResponse, successResponse } from 'src/utils/response/response';
import { RequirePermissions } from 'src/helper/decorators/permissions.decorator';

@RequirePermissions('goals.access')
@ApiBearerAuth('bearer')
@ApiTags('goals')
@Controller('goals')
export class GoalsController {
  constructor(private readonly goalsService: GoalsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a financial goal' })
  @ApiBody({ type: CreateGoalDto })
  @ApiResponse({ status: 200, description: 'Goal created' })
  @RequirePermissions('goals.create')
  async create(
    @Body() dto: CreateGoalDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const userId = req['user'].id as string;
      const result = await this.goalsService.create(userId, dto);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, 'Goal created.'));
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
  @ApiOperation({ summary: 'List goals with progress and predictions' })
  @RequirePermissions('goals.read')
  async findAll(@Req() req: Request, @Res() res: Response) {
    try {
      const userId = req['user'].id as string;
      const result = await this.goalsService.findAll(userId);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, 'Goals fetched.'));
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
  @ApiOperation({ summary: 'Get one goal' })
  @RequirePermissions('goals.read')
  async findOne(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const userId = req['user'].id as string;
      const result = await this.goalsService.findOne(userId, id);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, 'Goal found.'));
    } catch (error) {
      const message = error.message || 'An unexpected error occured';
      const statusCode =
        error.statuscode || error.status || HttpStatus.BAD_REQUEST;
      return res
        .status(statusCode)
        .send(errorResponse(message, statusCode, []));
    }
  }

  @Post(':id/contribute')
  @ApiOperation({ summary: 'Add a contribution to a manual goal' })
  @ApiBody({ type: ContributeGoalDto })
  @RequirePermissions('goals.update')
  async contribute(
    @Param('id') id: string,
    @Body() dto: ContributeGoalDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const userId = req['user'].id as string;
      const result = await this.goalsService.contribute(userId, id, dto);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, 'Contribution added.'));
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
  @ApiOperation({ summary: 'Update a goal' })
  @RequirePermissions('goals.update')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateGoalDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const userId = req['user'].id as string;
      const result = await this.goalsService.update(userId, id, dto);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, 'Goal updated.'));
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
  @ApiOperation({ summary: 'Soft-delete a goal' })
  @RequirePermissions('goals.delete')
  async remove(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const userId = req['user'].id as string;
      const result = await this.goalsService.remove(userId, id);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(result, 'Goal deleted.'));
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
