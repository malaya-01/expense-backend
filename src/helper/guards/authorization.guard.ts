import {
  Injectable,
  CanActivate,
  Inject,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Pool } from 'pg';
import appConfiguration from 'src/app.configuration';
import { isEmailVerificationRequired } from 'src/api/auth/auth.service';
import { SESSION_REPLACED_MESSAGE } from 'src/api/auth/session-state';

@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    @Inject('PG_POOL') private readonly pgPool: Pool,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride('isPublic', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    let token =
      request.headers['authorization'] || request.headers['Authorization'];
    token =
      token && typeof token === 'string' && token.startsWith('Bearer ')
        ? token.substring(7).trim()
        : null;

    if (!token || typeof token !== 'string') {
      throw new UnauthorizedException('Unauthorized access');
    }

    try {
      const secret = appConfiguration().JWT.SECRET;

      const payload = await this.jwtService.verifyAsync(token, { secret });
      if (!payload?.sub) {
        throw new UnauthorizedException('Unauthorized access');
      }
      // Refresh tokens must never be accepted as access tokens (they may be
      // signed with the same secret when only JWT_SECRET is configured).
      if (payload.typ === 'refresh') {
        throw new UnauthorizedException('Unauthorized access');
      }
      // One round trip for everything the guards need per request: session
      // state (one device per account), email verification and the admin
      // flag. This used to be 2–3 DB queries plus 3 Redis reads.
      const sessionId = payload.sid ? String(payload.sid) : null;
      const { rows } = await this.pgPool.query(
        `SELECT u.is_admin, u.email_verified,
                s.id AS session_id, s.revoked_at, s.revoked_reason, s.expires_at
         FROM users u
         LEFT JOIN user_sessions s ON s.id = $2
         WHERE u.id = $1 AND u.deleted_at IS NULL`,
        [payload.sub, sessionId],
      );
      const row = rows[0];
      if (!row) {
        throw new UnauthorizedException('Unauthorized access');
      }

      // Tokens carry their session: a device replaced by a newer login (or
      // signed out) is cut off now, not when its access token expires.
      if (sessionId) {
        if (row.revoked_at && row.revoked_reason === 'replaced') {
          throw new UnauthorizedException(SESSION_REPLACED_MESSAGE);
        }
        if (
          !row.session_id ||
          row.revoked_at ||
          new Date(row.expires_at) <= new Date()
        ) {
          throw new UnauthorizedException('Unauthorized access');
        }
      }

      const profile = {
        id: payload.sub,
        email_verified: Boolean(row.email_verified),
      };
      if (isEmailVerificationRequired() && !profile.email_verified) {
        throw new ForbiddenException(
          'EMAIL_NOT_VERIFIED: Please verify your email before continuing.',
        );
      }

      request['user'] = {
        id: payload.sub,
        email: payload.email,
        profile,
        // Read by PermissionsGuard so it does not query the flag again.
        db_is_admin: row.is_admin,
      };
      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      if (
        error instanceof UnauthorizedException &&
        error.message === SESSION_REPLACED_MESSAGE
      ) {
        throw error;
      }
      throw new UnauthorizedException('Unauthorized access');
    }
  }
}
