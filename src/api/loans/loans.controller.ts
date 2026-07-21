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
import { LoansService } from './loans.service';
import {
  CreateLoanDto,
  RecordLoanPaymentDto,
  UpdateLoanDto,
} from './dto/loan.dto';
import { successResponse } from 'src/utils/response/response';

@ApiBearerAuth('bearer')
@ApiTags('loans')
@Controller('loans')
export class LoansController {
  constructor(private readonly loansService: LoansService) {}

  @Get()
  async findAll(@Req() req: Request) {
    return successResponse(
      await this.loansService.findAll((req as any).user.id),
      'Debt plans fetched.',
    );
  }

  @Post()
  async create(@Req() req: Request, @Body() dto: CreateLoanDto) {
    return successResponse(
      await this.loansService.create((req as any).user.id, dto),
      'Debt plan created.',
    );
  }

  @Get(':id/amortization')
  async amortization(@Req() req: Request, @Param('id') id: string) {
    return successResponse(
      await this.loansService.amortization((req as any).user.id, id),
      'Amortization schedule generated.',
    );
  }

  @Post(':id/payments')
  async recordPayment(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: RecordLoanPaymentDto,
  ) {
    return successResponse(
      await this.loansService.recordPayment((req as any).user.id, id, dto),
      'Debt payment posted to the ledger.',
    );
  }

  @Get(':id')
  async findOne(@Req() req: Request, @Param('id') id: string) {
    return successResponse(
      await this.loansService.findOne((req as any).user.id, id),
      'Debt plan fetched.',
    );
  }

  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateLoanDto,
  ) {
    return successResponse(
      await this.loansService.update((req as any).user.id, id, dto),
      'Debt plan updated.',
    );
  }

  @Delete(':id')
  async archive(@Req() req: Request, @Param('id') id: string) {
    return successResponse(
      await this.loansService.archive((req as any).user.id, id),
      'Debt plan archived.',
    );
  }
}
