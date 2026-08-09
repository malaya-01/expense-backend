import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  PERMISSIONS_KEY,
  PERMISSIONS_MODE_KEY,
} from '../decorators/permissions.decorator';
import { PermissionsService } from 'src/api/permissions/permissions.service';
import { permissionSatisfied } from 'src/api/permissions/permission.codes';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissionsService: PermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Merge class + method requirements so module.access + CRUD both apply.
    const classPerms =
      this.reflector.get<string[]>(PERMISSIONS_KEY, context.getClass()) || [];
    const methodPerms =
      this.reflector.get<string[]>(PERMISSIONS_KEY, context.getHandler()) || [];
    const required = Array.from(new Set([...classPerms, ...methodPerms]));

    const methodMode = this.reflector.get<'all' | 'any'>(
      PERMISSIONS_MODE_KEY,
      context.getHandler(),
    );
    const classMode = this.reflector.get<'all' | 'any'>(
      PERMISSIONS_MODE_KEY,
      context.getClass(),
    );
    const mode = methodMode || classMode || 'all';

    const request = context.switchToHttp().getRequest();
    const userId = request?.user?.id as string | undefined;

    if (!userId) {
      if (!required.length) return true;
      throw new ForbiddenException('Insufficient permissions');
    }

    const access = await this.permissionsService.resolveEffectiveAccess(userId);
    request.user = {
      ...request.user,
      is_admin: access.is_admin,
      permissions: access.permissions,
    };

    if (!required.length) return true;
    if (access.is_admin) return true;

    const granted = access.permissions;
    const ok =
      mode === 'any'
        ? required.some((code) => permissionSatisfied(granted, code))
        : required.every((code) => permissionSatisfied(granted, code));

    if (!ok) {
      throw new ForbiddenException(
        `Missing permission: ${required.join(mode === 'any' ? ' or ' : ', ')}`,
      );
    }
    return true;
  }
}
