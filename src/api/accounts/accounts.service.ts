import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import { convertAmount } from 'src/common/currency/currency.data';

const LIABILITY_TYPES = new Set(['credit_card', 'loan', 'payable']);

@Injectable()
export class AccountsService {
  constructor(
    @Inject('PG_POOL')
    private readonly pgPool: Pool,
  ) {}

  async create(userId: string, dto: CreateAccountDto) {
    const client = await this.pgPool.connect();
    try {
      await client.query('BEGIN');
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

      const clientId = (dto as { id?: string }).id;
      const result = await client.query(
        clientId
          ? `INSERT INTO financial_containers
              (id, user_id, name, type, balance, currency, institution, color, notes, include_in_net_worth)
             VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $8, $9)
             RETURNING id, user_id, name, type, balance, currency, institution, color, notes,
                       include_in_net_worth, created_at, updated_at, deleted_at`
          : `INSERT INTO financial_containers
              (user_id, name, type, balance, currency, institution, color, notes, include_in_net_worth)
             VALUES ($1, $2, $3, 0, $4, $5, $6, $7, $8)
             RETURNING id, user_id, name, type, balance, currency, institution, color, notes,
                       include_in_net_worth, created_at, updated_at, deleted_at`,
        clientId
          ? [
              clientId,
              userId,
              dto.name,
              dto.type,
              (dto.currency || 'USD').toUpperCase(),
              dto.institution || null,
              dto.color || null,
              dto.notes || null,
              dto.include_in_net_worth ?? true,
            ]
          : [
              userId,
              dto.name,
              dto.type,
              (dto.currency || 'USD').toUpperCase(),
              dto.institution || null,
              dto.color || null,
              dto.notes || null,
              dto.include_in_net_worth ?? true,
            ],
      );
      const container = result.rows[0];
      if (Number(dto.balance || 0) !== 0) {
        await this.postBalanceAdjustment(
          client,
          userId,
          {
            id: container.id,
            name: container.name,
            type: container.type,
            currency: container.currency,
          },
          Number(dto.balance),
          'Opening balance',
        );
      }
      const refreshed = await client.query(
        `SELECT id, user_id, name, type, balance, currency, institution, color, notes,
                include_in_net_worth, created_at, updated_at, deleted_at
         FROM financial_containers
         WHERE id = $1 AND user_id = $2`,
        [container.id, userId],
      );
      await client.query('COMMIT');
      return this.normalize(refreshed.rows[0]);
    } catch (error: any) {
      await client.query('ROLLBACK');
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
                include_in_net_worth, space_id, created_at, updated_at, deleted_at
         FROM financial_containers
         WHERE user_id = $1 AND deleted_at IS NULL AND space_id IS NULL
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
                include_in_net_worth, space_id, created_at, updated_at, deleted_at
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
      await client.query('BEGIN');
      const currentResult = await client.query(
        `SELECT id, name, type, balance, currency
         FROM financial_containers
         WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [userId, id],
      );
      if (!currentResult.rowCount) {
        throw new NotFoundException('Financial container not found');
      }
      const current = currentResult.rows[0];
      const structuralChange =
        (dto.currency &&
          dto.currency.toUpperCase() !==
            String(current.currency).toUpperCase()) ||
        (dto.type && dto.type !== current.type);
      if (structuralChange) {
        const activity = await client.query(
          `SELECT EXISTS (
             SELECT 1 FROM ledger_transactions
             WHERE (source_container_id = $1 OR destination_container_id = $1)
           ) AS has_activity`,
          [id],
        );
        if (activity.rows[0]?.has_activity) {
          throw new BadRequestException(
            'Container type or currency cannot change after ledger activity exists.',
          );
        }
      }

      const allowed = [
        'name',
        'type',
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
        if (dto.balance === undefined || dto.balance === null) {
          throw new BadRequestException('No values found to update.');
        }
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
      if (fields.length) {
        values.push(userId, id);
        await client.query(
          `UPDATE financial_containers
           SET ${setClause}, updated_at = NOW()
           WHERE user_id = $${values.length - 1}
             AND id = $${values.length}
             AND deleted_at IS NULL`,
          values,
        );
      }

      const metadata = await client.query(
        `SELECT id, name, type, balance, currency
         FROM financial_containers
         WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [userId, id],
      );
      const updated = metadata.rows[0];
      if (
        dto.balance !== undefined &&
        dto.balance !== null &&
        Number(dto.balance) !== Number(current.balance)
      ) {
        await this.postBalanceAdjustment(
          client,
          userId,
          updated,
          Number(dto.balance) - Number(current.balance),
          'Manual balance adjustment',
        );
      }

      const result = await client.query(
        `SELECT id, user_id, name, type, balance, currency, institution, color, notes,
                include_in_net_worth, created_at, updated_at, deleted_at
         FROM financial_containers
         WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [userId, id],
      );
      await client.query('COMMIT');
      return this.normalize(result.rows[0]);
    } catch (error: any) {
      await client.query('ROLLBACK');
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
      return { id: result.rows[0].id, archived: true };
    } catch (error: any) {
      if (error?.status === 400 || error?.status === 404) throw error;
      throw new BadRequestException(
        error.message || 'Failed to delete financial container',
      );
    } finally {
      client.release();
    }
  }

  private async postBalanceAdjustment(
    client: PoolClient,
    userId: string,
    container: {
      id: string;
      name: string;
      type: string;
      currency: string;
    },
    displayedDelta: number,
    reason: string,
  ) {
    if (!Number.isFinite(displayedDelta) || displayedDelta === 0) return;
    const user = await client.query(
      `SELECT currency FROM users WHERE id = $1`,
      [userId],
    );
    const baseCurrency = String(user.rows[0]?.currency || 'USD').toUpperCase();
    const nativeAmount = Math.abs(displayedDelta);
    const amountBase = convertAmount(
      nativeAmount,
      String(container.currency).toUpperCase(),
      baseCurrency,
    );
    const liability = LIABILITY_TYPES.has(container.type);
    const increase = displayedDelta > 0;
    const containerDebit = liability ? !increase : increase;

    const journal = await client.query(
      `INSERT INTO ledger_journals
        (user_id, description, source_module, reference_container_id, metadata)
       VALUES ($1, $2, 'accounts', $3, $4::jsonb)
       RETURNING id`,
      [
        userId,
        `${reason}: ${container.name}`,
        container.id,
        JSON.stringify({ reason, displayed_delta: displayedDelta }),
      ],
    );
    await client.query(
      `INSERT INTO ledger_journal_lines
        (journal_id, container_id, account_code, debit_base, credit_base,
         native_amount, currency, sequence_number, metadata)
       VALUES
        ($1, $2, NULL, $3, $4, $5, $6, 1, $7::jsonb),
        ($1, NULL, 'equity:opening_balance', $4, $3, $5, $6, 2, $7::jsonb)`,
      [
        journal.rows[0].id,
        container.id,
        containerDebit ? amountBase : 0,
        containerDebit ? 0 : amountBase,
        nativeAmount,
        container.currency,
        JSON.stringify({ reason, displayed_delta: displayedDelta }),
      ],
    );
    await client.query(
      `UPDATE financial_containers
       SET balance = balance + $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3`,
      [displayedDelta, container.id, userId],
    );
  }

  private normalize(row: any) {
    return {
      ...row,
      balance: Number(row.balance),
      include_in_net_worth: Boolean(row.include_in_net_worth),
    };
  }
}
