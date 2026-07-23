import { Module } from '@nestjs/common';
import { TransactionsModule } from '../transactions/transactions.module';
import { LoansController } from './loans.controller';
import { LoansService } from './loans.service';

@Module({
  imports: [TransactionsModule],
  controllers: [LoansController],
  providers: [LoansService],
  exports: [LoansService],
})
export class LoansModule {}
