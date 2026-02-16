import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { CacheModule } from '@nestjs/cache-manager';
import * as redisStore from 'cache-manager-ioredis';
import appConfiguration from './app.configuration';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './api/auth/auth.module';
import { UserModule } from './api/user/user.module';
import { ThrottleConfigModule } from './throttle/throttle.module';
import { ExpenseModule } from './api/expense/expense.module';
import { CategoriesModule } from './api/categories/categories.module';


@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    CacheModule.registerAsync({
      isGlobal: true,
      useFactory: async () => ({
        store: redisStore,
        url: appConfiguration().CACHE.REDIS_URL,
        ttl: 0,
      }),
    }),
    DatabaseModule,
    AuthModule,
    UserModule,
    ThrottleConfigModule,
    ExpenseModule,
    CategoriesModule
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
