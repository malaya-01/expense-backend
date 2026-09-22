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
import { Cache } from 'cache-manager';
import { Pool } from 'pg';
import appConfiguration from 'src/app.configuration';
import { isEmailVerificationRequired } from 'src/api/auth/auth.service';

@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    @Inject('CACHE_MANAGER') private cache: Cache,
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
      const secret =
        process.env.JWT_ACCESS_SECRET ||
        process.env.JWT_SECRET ||
        appConfiguration().JWT.SECRET;

      const payload = await this.jwtService.verifyAsync(token, { secret });
      if (!payload?.sub) {
        throw new UnauthorizedException('Unauthorized access');
      }

      const allUsers: any[] = (await this.cache.get('all_users')) || [];
      let profile =
        allUsers.find((obj: any) => obj.id === payload.sub) || null;

      if (isEmailVerificationRequired()) {
        let verified = profile?.email_verified;
        if (verified === undefined || verified === null) {
          const row = await this.pgPool.query(
            `SELECT email_verified FROM users
             WHERE id = $1 AND deleted_at IS NULL`,
            [payload.sub],
          );
          verified = Boolean(row.rows[0]?.email_verified);
          profile = { ...(profile || { id: payload.sub }), email_verified: verified };
        }
        if (!verified) {
          throw new ForbiddenException(
            'EMAIL_NOT_VERIFIED: Please verify your email before continuing.',
          );
        }
      }

      request['user'] = {
        id: payload.sub,
        email: payload.email,
        profile,
      };
      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new UnauthorizedException('Unauthorized access');
    }
  }
}
