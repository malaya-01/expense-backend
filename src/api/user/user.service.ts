import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import {
  getCountry,
  isSupportedCurrency,
} from 'src/common/currency/currency.data';
import {
  ChangePasswordDto,
  UpdateProfileDto,
} from './dto/update-profile.dto';
import {
  DeleteAccountDto,
  sanitizeUserPreferences,
  type UserPreferences,
} from './dto/user-preferences.dto';
import {
  assertAvatarFile,
  deleteAvatarFile,
} from './avatar-storage';
import { ObjectStorageService } from 'src/storage/object-storage.service';

@Injectable()
export class UserService {
  constructor(
    @Inject('PG_POOL') private readonly pgPool: Pool,
    @Inject(CACHE_MANAGER)
    private cacheManager: Cache,
    private readonly storage: ObjectStorageService,
  ) {}

  async syncUsersToCache() {
    const cacheKey = 'all_users';
    const users = await this.pgPool.query(
      `SELECT id, email_verified FROM users
       WHERE COALESCE(is_delete, false) = false
         AND COALESCE(is_active, true) = true
         AND deleted_at IS NULL`,
    );
    await this.cacheManager.set(cacheKey, users.rows);
    return users.rows;
  }

  async findOne(id: string) {
    const result = await this.pgPool.query(
      `SELECT id, full_name, email, country, currency, timezone, locale,
              avatar_url, email_verified, is_admin, preferences,
              created_at, updated_at
       FROM users
       WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    if (!result.rowCount) return null;
    return result.rows[0];
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const existing = await this.findOne(userId);
    if (!existing) throw new NotFoundException('User not found');

    let country = existing.country as string | null;
    let currency = (existing.currency as string) || 'USD';
    let timezone = (existing.timezone as string) || 'UTC';
    let locale = (existing.locale as string) || 'en-US';
    let fullName = existing.full_name as string | null;

    if (dto.full_name !== undefined) {
      fullName = dto.full_name.trim();
      if (!fullName) throw new BadRequestException('Full name is required');
    }
    if (dto.country !== undefined) {
      const code = dto.country.toUpperCase();
      if (!getCountry(code)) throw new BadRequestException('Unsupported country');
      country = code;
    }
    if (dto.currency !== undefined) {
      const code = dto.currency.toUpperCase();
      if (!isSupportedCurrency(code)) {
        throw new BadRequestException('Unsupported currency');
      }
      currency = code;
    }
    if (dto.timezone !== undefined) {
      timezone = dto.timezone.trim() || 'UTC';
      if (!isValidTimeZone(timezone)) {
        throw new BadRequestException('Unsupported timezone');
      }
    }
    if (dto.locale !== undefined) {
      locale = dto.locale.trim() || 'en-US';
      if (!isValidLocale(locale)) {
        throw new BadRequestException('Unsupported locale');
      }
    }
    // Offline sync pushes this payload without the ValidationPipe, so the
    // preferences object is re-sanitised here; it is merged, not replaced.
    const preferencesPatch =
      dto.preferences !== undefined
        ? sanitizeUserPreferences(dto.preferences)
        : {};

    const result = await this.pgPool.query(
      `UPDATE users
       SET full_name = $2,
           country = $3,
           currency = $4,
           timezone = $5,
           locale = $6,
           preferences = COALESCE(preferences, '{}'::jsonb) || $7::jsonb,
           updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id, full_name, email, country, currency, timezone, locale,
                 avatar_url, email_verified, preferences, created_at, updated_at`,
      [
        userId,
        fullName,
        country,
        currency,
        timezone,
        locale,
        JSON.stringify(preferencesPatch),
      ],
    );
    return result.rows[0];
  }

  async uploadAvatar(userId: string, file: Express.Multer.File) {
    assertAvatarFile(file);
    const existing = await this.findOne(userId);
    if (!existing) throw new NotFoundException('User not found');

    const saved = await this.storage.saveFile({
      userId,
      kind: 'avatar',
      body: file.buffer,
      mimeType: file.mimetype,
      filename: file.originalname,
    });
    const previous = existing.avatar_url as string | null;
    const avatarUrl = saved.publicPath;

    let result;
    try {
      result = await this.pgPool.query(
        `UPDATE users
         SET avatar_url = $2, updated_at = NOW()
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING id, full_name, email, country, currency, timezone, locale,
                   avatar_url, email_verified, created_at, updated_at`,
        [userId, avatarUrl],
      );
    } catch (error) {
      await this.storage.deletePublicPath(avatarUrl, userId);
      throw error;
    }

    if (previous && previous !== avatarUrl) {
      // Best-effort (never throws): legacy local file + previous R2 object.
      deleteAvatarFile(previous);
      await this.storage.deletePublicPath(previous, userId);
    }

    return result.rows[0];
  }

  async removeAvatar(userId: string) {
    const existing = await this.findOne(userId);
    if (!existing) throw new NotFoundException('User not found');

    const previous = existing.avatar_url as string | null;
    const result = await this.pgPool.query(
      `UPDATE users
       SET avatar_url = NULL, updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id, full_name, email, country, currency, timezone, locale,
                 avatar_url, email_verified, created_at, updated_at`,
      [userId],
    );
    deleteAvatarFile(previous);
    await this.storage.deletePublicPath(previous, userId);
    return result.rows[0];
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    if (dto.newPassword !== dto.confirmNewPassword) {
      throw new BadRequestException('New passwords do not match');
    }
    const result = await this.pgPool.query(
      `SELECT password_hash FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    if (!result.rowCount) throw new NotFoundException('User not found');
    const valid = await bcrypt.compare(
      dto.currentPassword,
      result.rows[0].password_hash,
    );
    if (!valid) throw new UnauthorizedException('Current password is incorrect');

    const passwordHash = await bcrypt.hash(dto.newPassword, 10);
    const client = await this.pgPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1`,
        [userId, passwordHash],
      );
      // A password change signs out every existing refresh-token session.
      await client.query(
        `UPDATE user_sessions
         SET revoked_at = NOW(), updated_at = NOW()
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      );
      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore rollback errors */
      }
      throw error;
    } finally {
      client.release();
    }
    return { message: 'Password updated successfully' };
  }

  async getNotificationPreferences(userId: string) {
    const result = await this.pgPool.query(
      `SELECT preferences FROM user_notification_preferences
       WHERE user_id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    const preferences =
      result.rows[0]?.preferences && typeof result.rows[0].preferences === 'object'
        ? result.rows[0].preferences
        : {};
    return { preferences };
  }

  async saveNotificationPreferences(
    userId: string,
    incoming: Record<string, unknown>,
  ) {
    const current = await this.getNotificationPreferences(userId);
    const currentPrefs = (current.preferences || {}) as Record<string, unknown>;
    const currentIds = Array.isArray(currentPrefs.dismissed_ids)
      ? currentPrefs.dismissed_ids.map(String)
      : [];
    const incomingIds = Array.isArray(incoming.dismissed_ids)
      ? incoming.dismissed_ids.map(String)
      : [];
    const preferences = {
      ...currentPrefs,
      ...incoming,
      dismissed_ids: [...new Set([...currentIds, ...incomingIds])],
    };
    const result = await this.pgPool.query(
      `INSERT INTO user_notification_preferences (user_id, preferences, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         preferences = EXCLUDED.preferences,
         updated_at = NOW(),
         deleted_at = NULL
       RETURNING preferences`,
      [userId, JSON.stringify(preferences)],
    );
    return { preferences: result.rows[0]?.preferences || preferences };
  }

  async getThemePreferences(userId: string) {
    const result = await this.pgPool.query(
      `SELECT active_theme_id, custom_themes
       FROM user_ui_preferences
       WHERE user_id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    const row = result.rows[0];
    const customThemes = Array.isArray(row?.custom_themes)
      ? row.custom_themes
      : [];
    return {
      active_theme_id: (row?.active_theme_id as string) || null,
      custom_themes: customThemes,
      has_preference: Boolean(row),
    };
  }

  async saveThemePreferences(
    userId: string,
    dto: {
      active_theme_id: string;
      custom_themes?: unknown[];
    },
  ) {
    const activeThemeId = String(dto.active_theme_id || '').trim();
    if (!activeThemeId) {
      throw new BadRequestException('active_theme_id is required');
    }
    const customThemes = Array.isArray(dto.custom_themes)
      ? dto.custom_themes.slice(0, 40)
      : [];
    const result = await this.pgPool.query(
      `INSERT INTO user_ui_preferences
         (user_id, active_theme_id, custom_themes, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         active_theme_id = EXCLUDED.active_theme_id,
         custom_themes = EXCLUDED.custom_themes,
         updated_at = NOW(),
         deleted_at = NULL
       RETURNING active_theme_id, custom_themes`,
      [userId, activeThemeId, JSON.stringify(customThemes)],
    );
    const row = result.rows[0];
    return {
      active_theme_id: row?.active_theme_id as string,
      custom_themes: Array.isArray(row?.custom_themes) ? row.custom_themes : [],
      has_preference: true,
    };
  }

  // -- App preferences ----------------------------------------------------

  async getPreferences(userId: string) {
    const result = await this.pgPool.query(
      `SELECT preferences, updated_at FROM users
       WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    if (!result.rowCount) throw new NotFoundException('User not found');
    return {
      preferences: sanitizeUserPreferences(result.rows[0].preferences),
      updated_at: result.rows[0].updated_at,
    };
  }

  /** Merge a validated preferences patch into users.preferences. */
  async updatePreferences(userId: string, patch: UserPreferences) {
    const clean = sanitizeUserPreferences(patch);
    const result = await this.pgPool.query(
      `UPDATE users
       SET preferences = COALESCE(preferences, '{}'::jsonb) || $2::jsonb,
           updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING preferences, updated_at`,
      [userId, JSON.stringify(clean)],
    );
    if (!result.rowCount) throw new NotFoundException('User not found');
    return {
      preferences: sanitizeUserPreferences(result.rows[0].preferences),
      updated_at: result.rows[0].updated_at,
    };
  }

  // -- Sessions -----------------------------------------------------------

  /**
   * Live refresh-token sessions for the user. `currentTokenHash` is the
   * SHA-256 hex of this device's refresh token (as stored), used only to flag
   * the row as the current device.
   */
  async listSessions(userId: string, currentTokenHash?: string | null) {
    const current =
      currentTokenHash && /^[0-9a-f]{64}$/i.test(currentTokenHash)
        ? currentTokenHash.toLowerCase()
        : null;
    const result = await this.pgPool.query(
      `SELECT id, user_agent, host(ip_address) AS ip_address,
              created_at, updated_at AS last_used_at, expires_at,
              ($2::text IS NOT NULL AND refresh_token = $2::text) AS current
       FROM user_sessions
       WHERE user_id = $1
         AND revoked_at IS NULL
         AND expires_at > NOW()
         AND COALESCE(is_delete, false) = false
       ORDER BY updated_at DESC NULLS LAST, created_at DESC
       LIMIT 50`,
      [userId, current],
    );
    return result.rows.map((row) => ({
      id: row.id as string,
      user_agent: (row.user_agent as string | null) ?? null,
      ip_address: (row.ip_address as string | null) ?? null,
      created_at: row.created_at,
      last_used_at: row.last_used_at,
      expires_at: row.expires_at,
      current: Boolean(row.current),
    }));
  }

  async revokeSession(userId: string, sessionId: string) {
    const result = await this.pgPool.query(
      `UPDATE user_sessions
       SET revoked_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND user_id = $1 AND revoked_at IS NULL
       RETURNING id`,
      [userId, sessionId],
    );
    if (!result.rowCount) throw new NotFoundException('Session not found');
    return { id: result.rows[0].id as string, revoked: true };
  }

  /**
   * Revoke every live session except the one behind `presentedRefreshToken`.
   * Refuses when the current session cannot be identified, so the caller is
   * never signed out by accident.
   */
  async revokeOtherSessions(userId: string, presentedRefreshToken: string) {
    const token = String(presentedRefreshToken || '').trim();
    if (!token) {
      throw new BadRequestException(
        'Could not identify this device. Sign in again, then retry.',
      );
    }
    const currentHash = hashSessionToken(token);
    const current = await this.pgPool.query(
      `SELECT id FROM user_sessions
       WHERE user_id = $1 AND refresh_token = $2
         AND revoked_at IS NULL AND expires_at > NOW()`,
      [userId, currentHash],
    );
    if (!current.rowCount) {
      throw new BadRequestException(
        'Could not identify this device. Sign in again, then retry.',
      );
    }
    const result = await this.pgPool.query(
      `UPDATE user_sessions
       SET revoked_at = NOW(), updated_at = NOW()
       WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL
       RETURNING id`,
      [userId, current.rows[0].id],
    );
    return { revoked: result.rowCount || 0 };
  }

  // -- Account deletion ---------------------------------------------------

  /**
   * Soft-delete the account: marks the user deleted/inactive and revokes
   * every session. Data rows are kept (recoverable by an operator).
   */
  async deleteAccount(userId: string, dto: DeleteAccountDto) {
    const found = await this.pgPool.query(
      `SELECT password_hash FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    if (!found.rowCount) throw new NotFoundException('User not found');
    const valid = await bcrypt.compare(
      dto.password,
      found.rows[0].password_hash,
    );
    // 400, not 401: a 401 makes the web client refresh + retry the request.
    if (!valid) throw new BadRequestException('Password is incorrect');

    const client = await this.pgPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        // users.email is UNIQUE; swap in a placeholder so the address can be
        // used to sign up again after the account is deleted.
        `UPDATE users
         SET deleted_at = NOW(), is_active = false, is_delete = true,
             email = 'deleted+' || id::text || '@deleted.invalid',
             updated_at = NOW()
         WHERE id = $1 AND deleted_at IS NULL`,
        [userId],
      );
      await client.query(
        `UPDATE user_sessions
         SET revoked_at = NOW(), updated_at = NOW()
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      );
      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore rollback errors */
      }
      throw error;
    } finally {
      client.release();
    }
    // Drop the user from the auth guard's cache so access tokens stop working.
    try {
      await this.syncUsersToCache();
    } catch {
      /* cache refresh is best-effort */
    }
    // Remove uploaded files (avatar, receipts, ...) under users/{id}/.
    // Best-effort: the account is already deleted, so never fail here.
    try {
      await this.storage.purgeUserFiles(userId);
    } catch (error) {
      console.error(
        `[user] purgeUserFiles failed for deleted user ${userId}:`,
        (error as Error)?.message || error,
      );
    }
    return { deleted: true };
  }
}

/** Same scheme as auth.service hashRefreshToken (SHA-256 hex). */
function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function isValidLocale(locale: string): boolean {
  try {
    return Intl.getCanonicalLocales(locale).length > 0;
  } catch {
    return false;
  }
}
