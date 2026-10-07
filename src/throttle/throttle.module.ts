import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { AppThrottlerGuard } from './app-throttler.guard';

/** Positive integer from env, else the fallback. */
function envLimit(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        // Absorbs runaway client loops without hurting normal page loads,
        // which fire ~15-25 parallel requests at once.
        name: 'burst',
        ttl: 1_000,
        limit: envLimit('THROTTLE_BURST_PER_SECOND', 40),
      },
      {
        // Sustained budget per signed-in user (per IP when signed out).
        // Auth routes tighten this with @Throttle({ default: ... }).
        name: 'default',
        ttl: 60_000,
        limit: envLimit('THROTTLE_PER_MINUTE', 600),
      },
    ]),
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: AppThrottlerGuard,
    },
  ],
  exports: [ThrottlerModule],
})
export class ThrottleConfigModule {}
