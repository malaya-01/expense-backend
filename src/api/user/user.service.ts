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
              avatar_url, email_verified, created_at, updated_at
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
    let avatarUrl = existing.avatar_url as string | null;

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
    if (dto.avatar_url !== undefined) {
      if (dto.avatar_url === null || dto.avatar_url === '') {
        avatarUrl = null;
      } else if (
        !dto.avatar_url.startsWith('data:image/') &&
        !dto.avatar_url.startsWith('http://') &&
        !dto.avatar_url.startsWith('https://')
      ) {
        throw new BadRequestException('Invalid avatar image');
      } else {
        avatarUrl = dto.avatar_url;
      }
    }

    const result = await this.pgPool.query(
      `UPDATE users
       SET full_name = $2,
           country = $3,
           currency = $4,
           timezone = $5,
           locale = $6,
           avatar_url = $7,
           updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id, full_name, email, country, currency, timezone, locale,
                 avatar_url, email_verified, created_at, updated_at`,
      [userId, fullName, country, currency, timezone, locale, avatarUrl],
    );
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
}
