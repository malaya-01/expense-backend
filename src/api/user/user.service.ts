import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

@Injectable()
export class UserService {

  constructor(
    @Inject('PG_POOL') private readonly pgPool: Pool,
    @Inject(CACHE_MANAGER)
    private cacheManager: Cache,
  ){}

  async syncUsersToCache() {
    const cacheKey = 'all_users';
    const users = await this.pgPool.query(`SELECT id FROM users WHERE is_delete = false AND is_active = true`);
    await this.cacheManager.set(cacheKey, users.rows)
    console.log('Users synced to cache successfully', await this.cacheManager.get(cacheKey))
    return users.rows

  }
  async findOne(id: string) {
    const result = await this.pgPool.query(
      `SELECT id, full_name, email, country, currency, timezone, locale,
              email_verified, created_at, updated_at
       FROM users
       WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    if (!result.rowCount) return null;
    return result.rows[0];
  }
}
