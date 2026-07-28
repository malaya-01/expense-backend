import { Module } from '@nestjs/common';
import { SyncService } from './sync.service';
import { SyncController } from './sync.controller';
import { AccountsModule } from '../accounts/accounts.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { CategoriesModule } from '../categories/categories.module';
import { BudgetsModule } from '../budgets/budgets.module';
import { GoalsModule } from '../goals/goals.module';
import { InvestmentsModule } from '../investments/investments.module';
import { LoansModule } from '../loans/loans.module';
import { RecurringModule } from '../recurring/recurring.module';
import { UserModule } from '../user/user.module';
import { AiAdvisorModule } from '../ai-advisor/ai-advisor.module';

@Module({
  imports: [
    AccountsModule,
    TransactionsModule,
    CategoriesModule,
    BudgetsModule,
    GoalsModule,
    InvestmentsModule,
    LoansModule,
    RecurringModule,
    UserModule,
    AiAdvisorModule,
  ],
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
