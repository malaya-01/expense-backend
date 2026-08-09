import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Pool } from 'pg';
import appConfiguration from 'src/app.configuration';
import { parseAdminEmails, permissionSatisfied } from './permission.codes';
import { UpdateUserPermissionsDto } from './dto/permissions.dto';

export type PermissionCatalogRow = {
  id: string;
  module: string;
  code: string;
  name: string;
  description: string | null;
  is_default: boolean;
};

export type UserPermissionRow = PermissionCatalogRow & {
  override_effect: 'GRANT' | 'REVOKE' | null;
  effective: boolean;
};

export type EffectiveAccess = {
  is_admin: boolean;
  permissions: string[];
};

const CACHE_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class PermissionsService implements OnModuleInit {
  constructor(
    @Inject('PG_POOL') private readonly pgPool: Pool,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async onModuleInit() {
    try {
      await this.bootstrapAdminsFromEnv();
    } catch (error) {
      console.error('Failed to bootstrap ADMIN_EMAILS:', error);
    }
  }

  cacheKey(userId: string) {
    return `user_permissions:${userId}`;
  }

  async invalidateUserCache(userId: string) {
    await this.cache.del(this.cacheKey(userId));
  }

  getAdminEmails(): string[] {
    return parseAdminEmails(
      process.env.ADMIN_EMAILS ||
        (appConfiguration() as { ADMIN_EMAILS?: string }).ADMIN_EMAILS,
    );
  }

  async bootstrapAdminsFromEnv() {
    const emails = this.getAdminEmails();
    if (!emails.length) return { updated: 0 };
    const result = await this.pgPool.query(
      `UPDATE users
       SET is_admin = TRUE, updated_at = NOW()
       WHERE LOWER(email) = ANY($1::text[])
         AND deleted_at IS NULL
         AND is_admin = FALSE
       RETURNING id, email`,
      [emails],
    );
    for (const row of result.rows) {
      await this.invalidateUserCache(row.id);
    }
    return { updated: result.rowCount ?? 0, users: result.rows };
  }

  async markAdminIfBootstrapEmail(userId: string, email: string) {
    const emails = this.getAdminEmails();
    if (!emails.includes(email.trim().toLowerCase())) return false;
    await this.pgPool.query(
      `UPDATE users SET is_admin = TRUE, updated_at = NOW() WHERE id = $1`,
      [userId],
    );
    await this.invalidateUserCache(userId);
    return true;
  }

  async getUserAdminFlag(userId: string): Promise<boolean> {
    const result = await this.pgPool.query(
      `SELECT is_admin FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    return Boolean(result.rows[0]?.is_admin);
  }

  async resolveEffectiveAccess(userId: string): Promise<EffectiveAccess> {
    const cached = await this.cache.get<EffectiveAccess>(this.cacheKey(userId));
    if (cached) return cached;

    const adminResult = await this.pgPool.query(
      `SELECT is_admin FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    if (!adminResult.rowCount) {
      throw new NotFoundException('User not found');
    }
    const is_admin = Boolean(adminResult.rows[0].is_admin);

    const rows = await this.pgPool.query(
      `SELECT p.code, p.is_default, o.effect AS override_effect
       FROM permissions p
       LEFT JOIN permission_overrides o
         ON o.permission_id = p.id
        AND o.user_id = $1
        AND o.is_active = TRUE
        AND o.is_deleted = FALSE
       WHERE p.is_active = TRUE AND p.is_deleted = FALSE
       ORDER BY p.module, p.code`,
      [userId],
    );

    const permissions = rows.rows
      .filter((row) => {
        if (row.override_effect === 'REVOKE') return false;
        if (row.override_effect === 'GRANT') return true;
        return Boolean(row.is_default);
      })
      .map((row) => row.code as string);

    // Super-admins effectively hold every catalog permission.
    const effective: EffectiveAccess = {
      is_admin,
      permissions: is_admin
        ? rows.rows.map((r) => r.code as string)
        : permissions,
    };

    await this.cache.set(this.cacheKey(userId), effective, CACHE_TTL_MS);
    return effective;
  }

  async hasPermission(userId: string, ...codes: string[]): Promise<boolean> {
    if (!codes.length) return true;
    const access = await this.resolveEffectiveAccess(userId);
    if (access.is_admin) return true;
    return codes.every((code) =>
      permissionSatisfied(access.permissions, code),
    );
  }

  async listCatalog(): Promise<PermissionCatalogRow[]> {
    const result = await this.pgPool.query(
      `SELECT id, module, code, name, description, is_default
       FROM permissions
       WHERE is_active = TRUE AND is_deleted = FALSE
       ORDER BY module, code`,
    );
    return result.rows;
  }

  async listUsers(q?: string, limit = 50, offset = 0) {
    const capped = Math.min(Math.max(limit, 1), 200);
    const skip = Math.max(offset, 0);
    const params: unknown[] = [];
    let where = `deleted_at IS NULL AND COALESCE(is_delete, false) = false`;
    if (q?.trim()) {
      params.push(`%${q.trim().toLowerCase()}%`);
      where += ` AND (LOWER(email) LIKE $${params.length} OR LOWER(COALESCE(full_name, '')) LIKE $${params.length})`;
    }
    params.push(capped);
    const limitIdx = params.length;
    params.push(skip);
    const offsetIdx = params.length;

    const result = await this.pgPool.query(
      `SELECT id, email, full_name, avatar_url, is_admin, created_at, last_login_at
       FROM users
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );
    const countResult = await this.pgPool.query(
      `SELECT COUNT(*)::int AS total FROM users WHERE ${where}`,
      params.slice(0, params.length - 2),
    );
    return {
      users: result.rows,
      total: countResult.rows[0]?.total ?? 0,
      limit: capped,
      offset: skip,
    };
  }

  async getUserPermissions(userId: string): Promise<{
    user: Record<string, unknown>;
    permissions: UserPermissionRow[];
    effective: string[];
    is_admin: boolean;
  }> {
    const userResult = await this.pgPool.query(
      `SELECT id, email, full_name, avatar_url, is_admin, created_at, last_login_at
       FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    if (!userResult.rowCount) throw new NotFoundException('User not found');

    const rows = await this.pgPool.query(
      `SELECT p.id, p.module, p.code, p.name, p.description, p.is_default,
              o.effect AS override_effect
       FROM permissions p
       LEFT JOIN permission_overrides o
         ON o.permission_id = p.id
        AND o.user_id = $1
        AND o.is_active = TRUE
        AND o.is_deleted = FALSE
       WHERE p.is_active = TRUE AND p.is_deleted = FALSE
       ORDER BY p.module, p.code`,
      [userId],
    );

    const is_admin = Boolean(userResult.rows[0].is_admin);
    const permissions: UserPermissionRow[] = rows.rows.map((row) => {
      const override_effect =
        (row.override_effect as 'GRANT' | 'REVOKE' | null) ?? null;
      let effective = Boolean(row.is_default);
      if (override_effect === 'GRANT') effective = true;
      if (override_effect === 'REVOKE') effective = false;
      if (is_admin) effective = true;
      return {
        id: row.id,
        module: row.module,
        code: row.code,
        name: row.name,
        description: row.description,
        is_default: row.is_default,
        override_effect,
        effective,
      };
    });

    return {
      user: userResult.rows[0],
      permissions,
      effective: permissions.filter((p) => p.effective).map((p) => p.code),
      is_admin,
    };
  }

  async updateUserPermissions(
    actorId: string,
    targetUserId: string,
    dto: UpdateUserPermissionsDto,
  ) {
    const actor = await this.resolveEffectiveAccess(actorId);
    if (!actor.is_admin && !actor.permissions.includes('admin.manage_permissions')) {
      throw new ForbiddenException('Insufficient permissions');
    }

    const target = await this.pgPool.query(
      `SELECT id, is_admin FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [targetUserId],
    );
    if (!target.rowCount) throw new NotFoundException('User not found');

    if (target.rows[0].is_admin && !actor.is_admin) {
      throw new ForbiddenException(
        'Only super-admins can change permissions for other super-admins',
      );
    }

    const catalog = await this.listCatalog();
    const byCode = new Map(catalog.map((p) => [p.code, p]));

    for (const item of dto.overrides) {
      if (!byCode.has(item.code)) {
        throw new BadRequestException(`Unknown permission code: ${item.code}`);
      }
    }

    // Project effective admin-management access after this change for self-edits.
    if (actorId === targetUserId && !actor.is_admin) {
      const current = await this.getUserPermissions(targetUserId);
      const projected = new Map(
        current.permissions.map((p) => [p.code, p.effective]),
      );
      for (const item of dto.overrides) {
        const meta = byCode.get(item.code)!;
        if (item.effect === 'GRANT') projected.set(item.code, true);
        else if (item.effect === 'REVOKE') projected.set(item.code, false);
        else projected.set(item.code, meta.is_default);
      }
      const stillCanManage =
        projected.get('admin.manage_permissions') === true ||
        projected.get('admin.access') === true;
      if (!stillCanManage) {
        throw new BadRequestException(
          'Cannot remove your own admin access. Ask another super-admin.',
        );
      }
    }

    for (const item of dto.overrides) {
      const perm = byCode.get(item.code)!;

      if (item.effect === null) {
        await this.pgPool.query(
          `UPDATE permission_overrides
           SET is_active = FALSE, is_deleted = TRUE, deleted_at = NOW(), updated_at = NOW()
           WHERE user_id = $1 AND permission_id = $2 AND is_deleted = FALSE`,
          [targetUserId, perm.id],
        );
        continue;
      }

      await this.pgPool.query(
        `INSERT INTO permission_overrides (user_id, permission_id, effect, changed_by, is_active, is_deleted)
         VALUES ($1, $2, $3, $4, TRUE, FALSE)
         ON CONFLICT (user_id, permission_id)
         DO UPDATE SET
           effect = EXCLUDED.effect,
           changed_by = EXCLUDED.changed_by,
           is_active = TRUE,
           is_deleted = FALSE,
           deleted_at = NULL,
           updated_at = NOW()`,
        [targetUserId, perm.id, item.effect, actorId],
      );
    }

    await this.invalidateUserCache(targetUserId);
    return this.getUserPermissions(targetUserId);
  }

  async setUserAdmin(actorId: string, targetUserId: string, isAdmin: boolean) {
    const actorIsAdmin = await this.getUserAdminFlag(actorId);
    if (!actorIsAdmin) {
      throw new ForbiddenException('Only super-admins can change is_admin');
    }
    if (actorId === targetUserId && !isAdmin) {
      throw new BadRequestException('You cannot remove your own super-admin flag');
    }

    const target = await this.pgPool.query(
      `SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [targetUserId],
    );
    if (!target.rowCount) throw new NotFoundException('User not found');

    await this.pgPool.query(
      `UPDATE users SET is_admin = $2, updated_at = NOW() WHERE id = $1`,
      [targetUserId, isAdmin],
    );
    await this.invalidateUserCache(targetUserId);
    return this.getUserPermissions(targetUserId);
  }

  async mePayload(userId: string) {
    const access = await this.resolveEffectiveAccess(userId);
    return {
      is_admin: access.is_admin,
      permissions: access.permissions,
    };
  }
}
