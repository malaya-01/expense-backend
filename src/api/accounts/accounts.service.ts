import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';

@Injectable()
export class AccountsService {
  constructor(
    @Inject('PG_POOL')
    private readonly pgPool: Pool,
  ) {}

  async create(userId: string, dto: CreateAccountDto) {
    const client = await this.pgPool.connect();
    try {
      const existing = await client.query(
        `SELECT id FROM financial_containers
         WHERE user_id = $1 AND name = $2 AND deleted_at IS NULL`,
        [userId, dto.name],
      );
      if (existing.rowCount !== 0) {
        throw new BadRequestException(
          'A container with this name already exists.',
        );
      }

      const result = await client.query(
        `INSERT INTO financial_containers
          (user_id, name, type, balance, currency, institution, color, notes, include_in_net_worth)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, user_id, name, type, balance, currency, institution, color, notes,
                   include_in_net_worth, created_at, updated_at, deleted_at`,
        [
          userId,
          dto.name,
          dto.type,
          dto.balance ?? 0,
          (dto.currency || 'USD').toUpperCase(),
          dto.institution || null,
          dto.color || null,
          dto.notes || null,
          dto.include_in_net_worth ?? true,
        ],
      );
      return this.normalize(result.rows[0]);
    } catch (error: any) {
      if (error?.status === 400) throw error;
      if (error?.code === '23505') {
        throw new BadRequestException(
          'A container with this name already exists.',
        );
      }
      throw new BadRequestException(
        error.message || 'Failed to create financial container',
      );
    } finally {
      client.release();
    }
  }

  async findAll(userId: string) {
    const client = await this.pgPool.connect();
    try {
      const result = await client.query(
        `SELECT id, user_id, name, type, balance, currency, institution, color, notes,
                include_in_net_worth, created_at, updated_at, deleted_at
         FROM financial_containers
         WHERE user_id = $1 AND deleted_at IS NULL
         ORDER BY name ASC`,
        [userId],
      );
      return result.rows.map((row) => this.normalize(row));
    } catch (error: any) {
      throw new BadRequestException(
        error.message || 'Failed to fetch financial containers',
      );
    } finally {
      client.release();
    }
  }

  async findOne(userId: string, id: string) {
    const client = await this.pgPool.connect();
    try {
      const result = await client.query(
        `SELECT id, user_id, name, type, balance, currency, institution, color, notes,
                include_in_net_worth, created_at, updated_at, deleted_at
         FROM financial_containers
         WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [userId, id],
      );
      if (!result.rowCount) {
        throw new NotFoundException('Financial container not found');
      }
      return this.normalize(result.rows[0]);
    } catch (error: any) {
      if (error?.status === 404) throw error;
      throw new BadRequestException(
        error.message || 'Failed to fetch financial container',
      );
    } finally {
      client.release();
    }
  }

  async update(userId: string, id: string, dto: UpdateAccountDto) {
    const client = await this.pgPool.connect();
    try {
      const allowed = [
        'name',
        'type',
        'balance',
        'currency',
        'institution',
        'color',
        'notes',
        'include_in_net_worth',
      ] as const;

      const fields = allowed.filter(
        (key) => dto[key] !== undefined && dto[key] !== null,
      );

      if (fields.length === 0) {
        throw new BadRequestException('No values found to update.');
      }

      const setClause = fields
        .map((field, index) => `${field} = $${index + 1}`)
        .join(', ');
      const values = fields.map((field) => {
        const value = dto[field];
        if (field === 'currency' && typeof value === 'string') {
          return value.toUpperCase();
        }
        return value;
      });
      values.push(userId, id);

      const result = await client.query(
        `UPDATE financial_containers
         SET ${setClause}, updated_at = NOW()
         WHERE user_id = $${values.length - 1}
           AND id = $${values.length}
           AND deleted_at IS NULL
         RETURNING id, user_id, name, type, balance, currency, institution, color, notes,
                   include_in_net_worth, created_at, updated_at, deleted_at`,
        values,
      );

      if (!result.rowCount) {
        throw new NotFoundException('Financial container not found');
      }
      return this.normalize(result.rows[0]);
    } catch (error: any) {
      if (error?.status === 400 || error?.status === 404) throw error;
      if (error?.code === '23505') {
        throw new BadRequestException(
          'A container with this name already exists.',
        );
      }
      throw new BadRequestException(
        error.message || 'Failed to update financial container',
      );
    } finally {
      client.release();
    }
  }

  async remove(userId: string, id: string) {
    const client = await this.pgPool.connect();
    try {
      const result = await client.query(
        `UPDATE financial_containers
         SET deleted_at = NOW(), updated_at = NOW()
         WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL
         RETURNING id`,
        [userId, id],
      );
      if (!result.rowCount) {
        throw new NotFoundException('Financial container not found');
      }
      return { id: result.rows[0].id, deleted: true };
    } catch (error: any) {
      if (error?.status === 404) throw error;
      throw new BadRequestException(
        error.message || 'Failed to delete financial container',
      );
    } finally {
      client.release();
    }
  }

  private normalize(row: any) {
    return {
      ...row,
      balance: Number(row.balance),
      include_in_net_worth: Boolean(row.include_in_net_worth),
    };
  }
}
