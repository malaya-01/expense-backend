import { Controller, Get, Inject } from '@nestjs/common';
import { AppService } from './app.service';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    @Inject('CACHE_MANAGER') private cache: Cache
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

// @Get('cache')
// async testCache() { await this.cache.set('test_key', 'Hello, Cache!' ); const value = await this.cache.get('test_key'); return value; } 
}
