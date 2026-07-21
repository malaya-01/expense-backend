import { Module } from '@nestjs/common';
import { AiAdvisorController } from './ai-advisor.controller';
import { AiAdvisorService } from './ai-advisor.service';
import { AiSettingsService } from './ai-settings.service';
import { AiToolsService } from './ai-tools.service';
import { AccountsModule } from '../accounts/accounts.module';
import { BudgetsModule } from '../budgets/budgets.module';
import { CategoriesModule } from '../categories/categories.module';
import { GoalsModule } from '../goals/goals.module';
import { InvestmentsModule } from '../investments/investments.module';
import { ReportsModule } from '../reports/reports.module';
import { TransactionsModule } from '../transactions/transactions.module';

@Module({
  imports: [
    AccountsModule,
    BudgetsModule,
    CategoriesModule,
    GoalsModule,
    InvestmentsModule,
    ReportsModule,
    TransactionsModule,
  ],
  controllers: [AiAdvisorController],
  providers: [AiAdvisorService, AiSettingsService, AiToolsService],
  exports: [AiAdvisorService, AiSettingsService],
})
export class AiAdvisorModule {}
