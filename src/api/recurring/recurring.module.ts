import { Module } from '@nestjs/common';
import { TransactionsModule } from '../transactions/transactions.module';
import { RecurringController } from './recurring.controller';
import { RecurringService } from './recurring.service';

@Module({
  imports: [TransactionsModule],
  controllers: [RecurringController],
  providers: [RecurringService],
})
export class RecurringModule {}
