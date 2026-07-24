import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { CacheModule } from '@nestjs/cache-manager';
import { createKeyv } from '@keyv/redis';
import appConfiguration from './app.configuration';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './api/auth/auth.module';
import { UserModule } from './api/user/user.module';
import { ThrottleConfigModule } from './throttle/throttle.module';
import { ExpenseModule } from './api/expense/expense.module';
import { CategoriesModule } from './api/categories/categories.module';
import { AccountsModule } from './api/accounts/accounts.module';
import { TransactionsModule } from './api/transactions/transactions.module';
import { FxModule } from './api/fx/fx.module';
import { BudgetsModule } from './api/budgets/budgets.module';
import { GoalsModule } from './api/goals/goals.module';
import { InvestmentsModule } from './api/investments/investments.module';
import { ReportsModule } from './api/reports/reports.module';
import { AiAdvisorModule } from './api/ai-advisor/ai-advisor.module';
import { LoansModule } from './api/loans/loans.module';
import { RecurringModule } from './api/recurring/recurring.module';
import { SpacesModule } from './api/spaces/spaces.module';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthorizationGuard } from './helper/guards/authorization.guard';


@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    CacheModule.registerAsync({
      isGlobal: true,
      useFactory: async () => {
        const redisUrl = appConfiguration().CACHE.REDIS_URL;
        const store = createKeyv(redisUrl, {
          namespace: 'finos',
        });
        store.on('error', (error: Error) => {
          console.error('Redis cache error:', error.message);
        });
        return {
          stores: [store],
          ttl: appConfiguration().CACHE.REDIS_TTL * 1000,
        };
      },
    }),
    DatabaseModule,
    AuthModule,
    UserModule,
    ThrottleConfigModule,
    ExpenseModule,
    CategoriesModule,
    AccountsModule,
    TransactionsModule,
    FxModule,
    BudgetsModule,
    GoalsModule,
    InvestmentsModule,
    ReportsModule,
    AiAdvisorModule,
    LoansModule,
    RecurringModule,
    SpacesModule,
  ],
  controllers: [AppController],
  providers: [AppService,
    {
      provide: 'APP_GUARD',
      useClass: AuthorizationGuard
    }
  ],
})
export class AppModule {}
