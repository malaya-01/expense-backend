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
import { RequirePermissions } from 'src/helper/decorators/permissions.decorator';

@RequirePermissions('loans.access')
@ApiBearerAuth('bearer')
@ApiTags('loans')
@Controller('loans')
export class LoansController {
  constructor(private readonly loansService: LoansService) {}

  @Get()
  @RequirePermissions('loans.read')
  async findAll(@Req() req: Request) {
    return successResponse(
      await this.loansService.findAll((req as any).user.id),
      'Debt plans fetched.',
    );
  }

  @Post()
  @RequirePermissions('loans.create')
  async create(@Req() req: Request, @Body() dto: CreateLoanDto) {
    return successResponse(
      await this.loansService.create((req as any).user.id, dto),
      'Debt plan created.',
    );
  }

  @Get(':id/amortization')
  @RequirePermissions('loans.read')
  async amortization(@Req() req: Request, @Param('id') id: string) {
    return successResponse(
      await this.loansService.amortization((req as any).user.id, id),
      'Amortization schedule generated.',
    );
  }

  @Post(':id/payments')
  @RequirePermissions('loans.update')
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
  @RequirePermissions('loans.read')
  async findOne(@Req() req: Request, @Param('id') id: string) {
    return successResponse(
      await this.loansService.findOne((req as any).user.id, id),
      'Debt plan fetched.',
    );
  }

  @Patch(':id')
  @RequirePermissions('loans.update')
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
  @RequirePermissions('loans.delete')
  async archive(@Req() req: Request, @Param('id') id: string) {
    return successResponse(
      await this.loansService.archive((req as any).user.id, id),
      'Debt plan archived.',
    );
  }
}
