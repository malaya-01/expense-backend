import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { OMNIROUTE_DAILY_SUCCESS_LIMIT } from './providers/omniroute.free-backends';

export type OmnirouteUsageSnapshot = {
  provider: 'omniroute';
  limit: number;
  used: number;
  remaining: number;
  usage_date: string;
};

function utcDateString(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class AiOmnirouteUsageService {
  constructor(
    @Inject('PG_POOL')
    private readonly pgPool: Pool,
  ) {}

  async getUsage(userId: string): Promise<OmnirouteUsageSnapshot> {
    const usageDate = utcDateString();
    const result = await this.pgPool.query(
      `SELECT success_count FROM ai_omniroute_usage_daily
       WHERE user_id = $1 AND usage_date = $2::date`,
      [userId, usageDate],
    );
    const used = Number(result.rows[0]?.success_count || 0);
    const limit = OMNIROUTE_DAILY_SUCCESS_LIMIT;
    return {
      provider: 'omniroute',
      limit,
      used,
      remaining: Math.max(0, limit - used),
      usage_date: usageDate,
    };
  }

  /** Reject early when the free OmniRoute daily quota is exhausted. */
  async assertWithinQuota(userId: string): Promise<OmnirouteUsageSnapshot> {
    const snap = await this.getUsage(userId);
    if (snap.remaining <= 0) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `Daily free OmniRoute limit reached (${snap.limit} successful requests). Resets at UTC midnight, or connect your own API key in Settings → AI.`,
          provider: 'omniroute',
          code: 'omniroute_daily_limit',
          limit: snap.limit,
          used: snap.used,
          remaining: 0,
          usage_date: snap.usage_date,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return snap;
  }

  /** Count only successful completions toward the daily free quota. */
  async recordSuccessfulRequest(userId: string): Promise<OmnirouteUsageSnapshot> {
    const usageDate = utcDateString();
    const result = await this.pgPool.query(
      `INSERT INTO ai_omniroute_usage_daily (user_id, usage_date, success_count)
       VALUES ($1, $2::date, 1)
       ON CONFLICT (user_id, usage_date)
       DO UPDATE SET
         success_count = ai_omniroute_usage_daily.success_count + 1,
         updated_at = NOW()
       RETURNING success_count`,
      [userId, usageDate],
    );
    const used = Number(result.rows[0]?.success_count || 1);
    const limit = OMNIROUTE_DAILY_SUCCESS_LIMIT;
    return {
      provider: 'omniroute',
      limit,
      used,
      remaining: Math.max(0, limit - used),
      usage_date: usageDate,
    };
  }
}
