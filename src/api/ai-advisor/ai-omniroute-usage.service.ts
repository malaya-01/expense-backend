import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PermissionsService } from '../permissions/permissions.service';
import { permissionSatisfied } from '../permissions/permission.codes';
import { OMNIROUTE_DAILY_SUCCESS_LIMIT } from './providers/omniroute.free-backends';

export type OmnirouteUsageSnapshot = {
  provider: 'omniroute';
  limit: number;
  used: number;
  remaining: number;
  usage_date: string;
  /** Super-admin (`is_admin`) or staff admin (`admin.access`) — no daily cap. */
  unlimited?: boolean;
};

function utcDateString(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class AiOmnirouteUsageService {
  constructor(
    @Inject('PG_POOL')
    private readonly pgPool: Pool,
    private readonly permissions: PermissionsService,
  ) {}

  /**
   * Free Groq/Gemini (Opal Free) daily request quota does not apply to
   * super-admins (`users.is_admin`) or staff admins (`admin.access`).
   */
  async isQuotaExempt(userId: string): Promise<boolean> {
    const access = await this.permissions.resolveEffectiveAccess(userId);
    if (access.is_admin) return true;
    return permissionSatisfied(access.permissions, 'admin.access');
  }

  async getUsage(userId: string): Promise<OmnirouteUsageSnapshot> {
    const usageDate = utcDateString();
    const exempt = await this.isQuotaExempt(userId);
    const result = await this.pgPool.query(
      `SELECT success_count FROM ai_omniroute_usage_daily
       WHERE user_id = $1 AND usage_date = $2::date`,
      [userId, usageDate],
    );
    const used = Number(result.rows[0]?.success_count || 0);
    if (exempt) {
      return {
        provider: 'omniroute',
        limit: 0,
        used,
        remaining: Number.MAX_SAFE_INTEGER,
        usage_date: usageDate,
        unlimited: true,
      };
    }
    const limit = OMNIROUTE_DAILY_SUCCESS_LIMIT;
    return {
      provider: 'omniroute',
      limit,
      used,
      remaining: Math.max(0, limit - used),
      usage_date: usageDate,
      unlimited: false,
    };
  }

  /** Reject early when the free OmniRoute daily quota is exhausted. */
  async assertWithinQuota(userId: string): Promise<OmnirouteUsageSnapshot> {
    const snap = await this.getUsage(userId);
    if (snap.unlimited) return snap;
    if (snap.remaining <= 0) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `Daily free Opal Free limit reached (${snap.limit} successful requests). Resets at UTC midnight, or connect your own API key in Settings → AI.`,
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
    if (await this.isQuotaExempt(userId)) {
      return this.getUsage(userId);
    }
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
      unlimited: false,
    };
  }
}
