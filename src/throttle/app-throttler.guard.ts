import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import * as jwt from 'jsonwebtoken';
import appConfiguration from 'src/app.configuration';

/**
 * Rate-limit signed-in traffic per user instead of per IP. Behind Render's
 * proxy, on mobile carrier NAT or shared Wi-Fi many people share one IP, and
 * a single dashboard load already fires a burst of parallel requests.
 *
 * Only a token that verifies with the access secret is trusted as an
 * identity; anything else (public routes, expired/forged tokens) falls back
 * to the client IP so it cannot be used to spread requests across buckets.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const header = req.headers?.authorization || req.headers?.Authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      try {
        const payload = jwt.verify(
          header.slice(7).trim(),
          appConfiguration().JWT.SECRET,
        ) as jwt.JwtPayload;
        if (payload?.sub && payload.typ !== 'refresh') {
          return `user:${payload.sub}`;
        }
      } catch {
        // Invalid or expired token: rate-limit by IP below.
      }
    }
    // With `trust proxy` set in main.ts, req.ip is the real client address.
    return `ip:${req.ip || 'unknown'}`;
  }
}
