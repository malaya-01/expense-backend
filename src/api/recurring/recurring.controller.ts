import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { successResponse } from 'src/utils/response/response';
import {
  CreateRecurringScheduleDto,
  UpdateRecurringScheduleDto,
} from './dto/recurring.dto';
import { RecurringService } from './recurring.service';

@ApiBearerAuth('bearer')
@ApiTags('recurring')
@Controller('recurring')
export class RecurringController {
  constructor(private readonly recurringService: RecurringService) {}

  @Get()
  async findAll(@Req() req: Request) {
    return successResponse(
      await this.recurringService.findAll((req as any).user.id),
      'Recurring schedules fetched.',
    );
  }

  @Post()
  async create(
    @Req() req: Request,
    @Body() dto: CreateRecurringScheduleDto,
  ) {
    return successResponse(
      await this.recurringService.create((req as any).user.id, dto),
      'Recurring schedule created.',
    );
  }

  @Get(':id/history')
  async history(@Req() req: Request, @Param('id') id: string) {
    return successResponse(
      await this.recurringService.history((req as any).user.id, id),
      'Execution history fetched.',
    );
  }

  @Post(':id/execute')
  async execute(@Req() req: Request, @Param('id') id: string) {
    return successResponse(
      await this.recurringService.execute((req as any).user.id, id),
      'Scheduled transaction posted.',
    );
  }

  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateRecurringScheduleDto,
  ) {
    return successResponse(
      await this.recurringService.update((req as any).user.id, id, dto),
      'Recurring schedule updated.',
    );
  }

  @Delete(':id')
  async archive(@Req() req: Request, @Param('id') id: string) {
    return successResponse(
      await this.recurringService.archive((req as any).user.id, id),
      'Recurring schedule archived.',
    );
  }
}
