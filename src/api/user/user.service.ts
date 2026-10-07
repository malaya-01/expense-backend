import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { randomBytes } from 'crypto';
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
  deleteAvatarFile,
} from './avatar-storage';
import { ObjectStorageService } from 'src/storage/object-storage.service';
import { SaveFaceLoginDto } from './dto/face-login.dto';
import {
  assertDescriptor,
  encryptFaceTemplate,
} from 'src/storage/face-template.crypto';

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

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

    const saved = await this.storage.saveFile({
      userId,
      kind: 'avatar',
      body: file.buffer,
      mimeType: file.mimetype,
      filename: file.originalname,
    });
    const previous = existing.avatar_url as string | null;
    const avatarUrl = saved.publicPath;

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
      await this.storage.deletePublicPath(previous);
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
    await this.storage.deletePublicPath(previous);
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

  async getFaceLogin(userId: string) {
    const result = await this.pgPool.query(
      `SELECT email FROM face_login_profiles WHERE user_id = $1`,
      [userId],
    );
    if (!result.rowCount) {
      return { enabled: false, email: null };
    }
    return {
      enabled: true,
      email: result.rows[0].email as string,
    };
  }

  async saveFaceLogin(userId: string, dto: SaveFaceLoginDto) {
    const user = await this.findOne(userId);
    if (!user) throw new NotFoundException('User not found');
    const descriptor = assertDescriptor(dto.descriptor);
    const envelope = encryptFaceTemplate(descriptor);
    const existing = await this.pgPool.query(
      `SELECT preview_token, preview_object_key FROM face_login_profiles WHERE user_id = $1`,
      [userId],
    );
    const previousPreview = existing.rows[0]?.preview_object_key as
      | string
      | undefined;
    const previewToken = existing.rows[0]?.preview_token as string | undefined;
    if (previewToken) {
      await this.storage.deletePublicPath(`/api/media/${previewToken}`);
    }

    let objectKey = `inline:${userId}`;
    let previewObjectKey: string | null = null;
    let storedInR2 = false;
    try {
      objectKey = `face-login/${userId}/profile.json`;
      await this.storage.putJson(objectKey, envelope);
      const photo = jpegFromPreview(dto.preview_base64);
      if (photo) {
        previewObjectKey = `face-login/${userId}/${randomBytes(16).toString('hex')}.jpg`;
        await this.storage.putBytes(previewObjectKey, photo, 'image/jpeg');
      }
      storedInR2 = true;
    } catch (error) {
      objectKey = `inline:${userId}`;
      previewObjectKey = null;
      const message = error instanceof Error ? error.message : 'R2 upload failed';
      this.logger.warn(`Face data was not stored in R2: ${message}`);
    }

    if (
      previousPreview &&
      previousPreview !== previewObjectKey &&
      !previousPreview.startsWith('inline:')
    ) {
      try {
        await this.storage.deleteKey(previousPreview);
      } catch {
        /* previous photo may already be gone */
      }
    }

    await this.pgPool.query(
      `INSERT INTO face_login_profiles
         (user_id, email, object_key, preview_token, preview_object_key, template, updated_at)
       VALUES ($1, $2, $3, NULL, $4, $5::jsonb, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         email = EXCLUDED.email,
         object_key = EXCLUDED.object_key,
         preview_token = NULL,
         preview_object_key = EXCLUDED.preview_object_key,
         template = EXCLUDED.template,
         updated_at = NOW()`,
      [userId, user.email, objectKey, previewObjectKey, JSON.stringify(envelope)],
    );
    return { ...(await this.getFaceLogin(userId)), stored_in_r2: storedInR2 };
  }

  async deleteFaceLogin(userId: string) {
    const existing = await this.pgPool.query(
      `SELECT object_key, preview_token, preview_object_key FROM face_login_profiles WHERE user_id = $1`,
      [userId],
    );
    if (existing.rowCount) {
      const row = existing.rows[0];
      const objectKey = String(row.object_key || '');
      const previewObjectKey = String(row.preview_object_key || '');
      for (const key of [objectKey, previewObjectKey]) {
        if (!key || key.startsWith('inline:')) continue;
        try {
          await this.storage.deleteKey(key);
        } catch {
          /* already removed */
        }
      }
      if (row.preview_token) {
        await this.storage.deletePublicPath(`/api/media/${row.preview_token}`);
      }
      await this.pgPool.query(
        `DELETE FROM face_login_profiles WHERE user_id = $1`,
        [userId],
      );
    }
    return { enabled: false };
  }
}

function jpegFromPreview(value: string | undefined): Buffer | null {
  if (!value) return null;
  const trimmed = value.trim();
  const comma = trimmed.indexOf(',');
  const payload = trimmed.startsWith('data:') && comma >= 0
    ? trimmed.slice(comma + 1)
    : trimmed;
  if (!payload || payload.length > 1_500_000) return null;
  const bytes = Buffer.from(payload, 'base64');
  if (bytes.length < 32 || bytes.length > 1_200_000) return null;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  return bytes;
}
