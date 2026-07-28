import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { convertAmount } from 'src/common/currency/currency.data';
import { CreateBudgetDto } from './dto/create-budget.dto';
import { UpdateBudgetDto } from './dto/update-budget.dto';

type PeriodWindow = {
  start: string;
  end: string;
};

@Injectable()
export class BudgetsService {
  constructor(
    @Inject('PG_POOL')
    private readonly pgPool: Pool,
  ) {}

  async create(userId: string, dto: CreateBudgetDto) {
    const client = await this.pgPool.connect();
    try {
      const baseCurrency = await this.getUserCurrency(client, userId);
      if (dto.category_id) {
        await this.assertCategory(client, userId, dto.category_id);
      }

      const clientId = (dto as { id?: string }).id;
      const result = await client.query(
        clientId
          ? `INSERT INTO budgets
              (id, user_id, category_id, name, amount, currency, period_type, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`
          : `INSERT INTO budgets
              (user_id, category_id, name, amount, currency, period_type, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
        clientId
          ? [
              clientId,
              userId,
              dto.category_id || null,
              dto.name.trim(),
              dto.amount,
              (dto.currency || baseCurrency).toUpperCase(),
              dto.period_type || 'monthly',
              dto.notes || null,
            ]
          : [
              userId,
              dto.category_id || null,
              dto.name.trim(),
              dto.amount,
              (dto.currency || baseCurrency).toUpperCase(),
              dto.period_type || 'monthly',
              dto.notes || null,
            ],
      );
      return this.withProgress(client, userId, result.rows[0]);
    } catch (error: any) {
      if (error?.status === 400 || error?.status === 404) throw error;
      if (error?.code === '23505') {
        throw new BadRequestException('A budget with this name already exists.');
      }
      throw new BadRequestException(error.message || 'Failed to create budget');
    } finally {
      client.release();
    }
  }

  async findAll(userId: string) {
    const client = await this.pgPool.connect();
    try {
      const result = await client.query(
        `SELECT b.*, c.name AS category_name, c.color AS category_color
         FROM budgets b
         LEFT JOIN categories c ON c.id = b.category_id
         WHERE b.user_id = $1 AND b.deleted_at IS NULL
         ORDER BY b.name ASC`,
        [userId],
      );
      const rows: any[] = [];
      for (const row of result.rows) {
        rows.push(await this.withProgress(client, userId, row));
      }
      return rows;
    } catch (error: any) {
      throw new BadRequestException(error.message || 'Failed to fetch budgets');
    } finally {
      client.release();
    }
  }

  async findOne(userId: string, id: string) {
    const client = await this.pgPool.connect();
    try {
      const result = await client.query(
        `SELECT b.*, c.name AS category_name, c.color AS category_color
         FROM budgets b
         LEFT JOIN categories c ON c.id = b.category_id
         WHERE b.user_id = $1 AND b.id = $2 AND b.deleted_at IS NULL`,
        [userId, id],
      );
      if (!result.rowCount) {
        throw new NotFoundException('Budget not found');
      }
      return this.withProgress(client, userId, result.rows[0]);
    } catch (error: any) {
      if (error?.status === 404) throw error;
      throw new BadRequestException(error.message || 'Failed to fetch budget');
    } finally {
      client.release();
    }
  }

  async update(userId: string, id: string, dto: UpdateBudgetDto) {
    const client = await this.pgPool.connect();
    try {
      await this.findRaw(client, userId, id);
      if (dto.category_id) {
        await this.assertCategory(client, userId, dto.category_id);
      }

      const allowed = [
        'name',
        'amount',
        'period_type',
        'category_id',
        'currency',
        'notes',
      ] as const;
      const sets: string[] = [];
      const values: unknown[] = [];
      let i = 1;

      for (const key of allowed) {
        if (dto[key] === undefined) continue;
        let value: unknown = dto[key];
        if (key === 'name' && typeof value === 'string') value = value.trim();
        if (key === 'currency' && typeof value === 'string') {
          value = value.toUpperCase();
        }
        if (key === 'category_id' && value === '') value = null;
        sets.push(`${key} = $${i++}`);
        values.push(value);
      }

      if (sets.length === 0) {
        return this.findOne(userId, id);
      }

      sets.push(`updated_at = NOW()`);
      values.push(id, userId);

      const result = await client.query(
        `UPDATE budgets
         SET ${sets.join(', ')}
         WHERE id = $${i++} AND user_id = $${i} AND deleted_at IS NULL
         RETURNING *`,
        values,
      );
      if (!result.rowCount) {
        throw new NotFoundException('Budget not found');
      }

      const enriched = await client.query(
        `SELECT b.*, c.name AS category_name, c.color AS category_color
         FROM budgets b
         LEFT JOIN categories c ON c.id = b.category_id
         WHERE b.id = $1`,
        [id],
      );
      return this.withProgress(client, userId, enriched.rows[0]);
    } catch (error: any) {
      if (error?.status === 400 || error?.status === 404) throw error;
      if (error?.code === '23505') {
        throw new BadRequestException('A budget with this name already exists.');
      }
      throw new BadRequestException(error.message || 'Failed to update budget');
    } finally {
      client.release();
    }
  }

  async remove(userId: string, id: string) {
    const client = await this.pgPool.connect();
    try {
      const result = await client.query(
        `UPDATE budgets
         SET deleted_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
         RETURNING id`,
        [id, userId],
      );
      if (!result.rowCount) {
        throw new NotFoundException('Budget not found');
      }
      return { id };
    } catch (error: any) {
      if (error?.status === 404) throw error;
      throw new BadRequestException(error.message || 'Failed to delete budget');
    } finally {
      client.release();
    }
  }

  private async findRaw(client: any, userId: string, id: string) {
    const result = await client.query(
      `SELECT id FROM budgets
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [id, userId],
    );
    if (!result.rowCount) {
      throw new NotFoundException('Budget not found');
    }
  }

  private async assertCategory(client: any, userId: string, categoryId: string) {
    const result = await client.query(
      `SELECT id FROM categories
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [categoryId, userId],
    );
    if (!result.rowCount) {
      throw new BadRequestException('Category not found');
    }
  }

  private async getUserCurrency(client: any, userId: string): Promise<string> {
    const result = await client.query(
      `SELECT currency FROM users WHERE id = $1`,
      [userId],
    );
    return (result.rows[0]?.currency || 'USD').toUpperCase();
  }

  private periodWindow(periodType: string, now = new Date()): PeriodWindow {
    const y = now.getFullYear();
    const m = now.getMonth();
    const d = now.getDate();

    if (periodType === 'weekly') {
      const day = now.getDay(); // 0 Sun
      const mondayOffset = day === 0 ? -6 : 1 - day;
      const start = new Date(y, m, d + mondayOffset);
      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      return { start: this.isoDate(start), end: this.isoDate(end) };
    }

    if (periodType === 'yearly') {
      return {
        start: `${y}-01-01`,
        end: `${y}-12-31`,
      };
    }

    // monthly
    const start = new Date(y, m, 1);
    const end = new Date(y, m + 1, 0);
    return { start: this.isoDate(start), end: this.isoDate(end) };
  }

  private isoDate(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  private async withProgress(client: any, userId: string, row: any) {
    const period = this.periodWindow(row.period_type);
    const currency = String(row.currency || 'USD').toUpperCase();

    const params: unknown[] = [userId, period.start, period.end];
    let categoryFilter = '';
    if (row.category_id) {
      categoryFilter = 'AND t.category_id = $4';
      params.push(row.category_id);
    }

    const spentResult = await client.query(
      `SELECT COALESCE(SUM(COALESCE(t.amount_base, t.amount)), 0) AS spent_base,
              COALESCE(
                (SELECT currency FROM users WHERE id = $1),
                'USD'
              ) AS base_currency
       FROM ledger_transactions t
       WHERE t.user_id = $1
         AND t.type = 'expense'
         AND t.deleted_at IS NULL
         AND t.date >= $2::date
         AND t.date <= $3::date
         ${categoryFilter}`,
      params,
    );

    const spentBase = Number(spentResult.rows[0]?.spent_base || 0);
    const baseCurrency = String(
      spentResult.rows[0]?.base_currency || 'USD',
    ).toUpperCase();
    const spent = convertAmount(spentBase, baseCurrency, currency);
    const amount = Number(row.amount);
    const remaining = Math.round((amount - spent + Number.EPSILON) * 100) / 100;
    const percent =
      amount > 0
        ? Math.round(((spent / amount) * 100 + Number.EPSILON) * 10) / 10
        : 0;

    let status: 'on_track' | 'warning' | 'over' = 'on_track';
    if (spent > amount) status = 'over';
    else if (percent >= 80) status = 'warning';

    return {
      id: row.id,
      user_id: row.user_id,
      category_id: row.category_id,
      category_name: row.category_name || null,
      category_color: row.category_color || null,
      name: row.name,
      amount,
      currency,
      period_type: row.period_type,
      notes: row.notes,
      created_at: row.created_at,
      updated_at: row.updated_at,
      period_start: period.start,
      period_end: period.end,
      spent,
      remaining,
      percent,
      status,
    };
  }
}
