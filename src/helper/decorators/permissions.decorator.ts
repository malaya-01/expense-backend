import { applyDecorators, SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'required_permissions';
export const PERMISSIONS_MODE_KEY = 'required_permissions_mode';

export type PermissionsMode = 'all' | 'any';

/** Require all listed permission codes (super-admin bypasses). */
export const RequirePermissions = (...codes: string[]) =>
  SetMetadata(PERMISSIONS_KEY, codes);

/** Require any of the listed permission codes (super-admin bypasses). */
export const RequireAnyPermission = (...codes: string[]) =>
  applyDecorators(
    SetMetadata(PERMISSIONS_KEY, codes),
    SetMetadata(PERMISSIONS_MODE_KEY, 'any' as PermissionsMode),
  );
