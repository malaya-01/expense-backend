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
import { LoansModule } from '../loans/loans.module';
import { RecurringModule } from '../recurring/recurring.module';
import { ReportsModule } from '../reports/reports.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { AiOmnirouteUsageService } from './ai-omniroute-usage.service';
import { AiWebSearchService } from './ai-web-search.service';
import { SpacesModule } from '../spaces/spaces.module';

@Module({
  imports: [
    AccountsModule,
    BudgetsModule,
    CategoriesModule,
    GoalsModule,
    InvestmentsModule,
    LoansModule,
    RecurringModule,
    ReportsModule,
    TransactionsModule,
    SpacesModule,
  ],
  controllers: [AiAdvisorController],
  providers: [
    AiAdvisorService,
    AiSettingsService,
    AiToolsService,
    AiWebSearchService,
    AiOmnirouteUsageService,
  ],
  exports: [AiAdvisorService, AiSettingsService],
})
export class AiAdvisorModule {}
