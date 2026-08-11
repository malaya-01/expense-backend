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
import {
  getCountry,
  isSupportedCurrency,
} from 'src/common/currency/currency.data';
import {
  ChangePasswordDto,
  UpdateProfileDto,
} from './dto/update-profile.dto';
import {
  assertAvatarFile,
  AVATAR_UPLOAD_DIR,
  buildAvatarFilename,
  deleteAvatarFile,
  ensureAvatarUploadDir,
  publicAvatarPath,
} from './avatar-storage';
import { writeFileSync } from 'fs';
import { join } from 'path';

@Injectable()
export class UserService {
  constructor(
    @Inject('PG_POOL') private readonly pgPool: Pool,
    @Inject(CACHE_MANAGER)
    private cacheManager: Cache,
  ) {}

  async syncUsersToCache() {
    const cacheKey = 'all_users';
    const users = await this.pgPool.query(
      `SELECT id FROM users
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
              avatar_url, email_verified, is_admin, created_at, updated_at
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
    }
    if (dto.locale !== undefined) {
      locale = dto.locale.trim() || 'en-US';
    }

    const result = await this.pgPool.query(
      `UPDATE users
       SET full_name = $2,
           country = $3,
           currency = $4,
           timezone = $5,
           locale = $6,
           updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id, full_name, email, country, currency, timezone, locale,
                 avatar_url, email_verified, created_at, updated_at`,
      [userId, fullName, country, currency, timezone, locale],
    );
    return result.rows[0];
  }

  async uploadAvatar(userId: string, file: Express.Multer.File) {
    assertAvatarFile(file);
    const existing = await this.findOne(userId);
    if (!existing) throw new NotFoundException('User not found');

    ensureAvatarUploadDir();
    const filename = buildAvatarFilename(userId, file.mimetype);
    writeFileSync(join(AVATAR_UPLOAD_DIR, filename), file.buffer);

    const previous = existing.avatar_url as string | null;
    const avatarUrl = publicAvatarPath(filename);

    const result = await this.pgPool.query(
      `UPDATE users
       SET avatar_url = $2, updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id, full_name, email, country, currency, timezone, locale,
                 avatar_url, email_verified, created_at, updated_at`,
      [userId, avatarUrl],
    );

    if (previous && previous !== avatarUrl) {
      deleteAvatarFile(previous);
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
    await this.pgPool.query(
      `UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1`,
      [userId, passwordHash],
    );
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
}
