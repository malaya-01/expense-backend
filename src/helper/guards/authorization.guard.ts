import {
  Injectable,
  CanActivate,
  Inject,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Cache } from 'cache-manager';
import appConfiguration from 'src/app.configuration';

@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    @Inject('CACHE_MANAGER') private cache: Cache,
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
      const profile =
        allUsers.find((obj: any) => obj.id === payload.sub) || null;

      request['user'] = {
        id: payload.sub,
        email: payload.email,
        profile,
      };
      return true;
    } catch {
      throw new UnauthorizedException('Unauthorized access');
    }
  }
}
