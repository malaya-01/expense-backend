import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { convertAmount } from 'src/common/currency/currency.data';
import { requireDateOnly, toDateOnly } from 'src/common/date/to-date-only';
import { CreateGoalDto } from './dto/create-goal.dto';
import { ContributeGoalDto, UpdateGoalDto } from './dto/update-goal.dto';

@Injectable()
export class GoalsService {
  constructor(
    @Inject('PG_POOL')
    private readonly pgPool: Pool,
  ) {}

  async create(userId: string, dto: CreateGoalDto) {
    const client = await this.pgPool.connect();
    try {
      const baseCurrency = await this.getUserCurrency(client, userId);
      if (dto.container_id) {
        await this.assertContainer(client, userId, dto.container_id);
      }

      const clientId = (dto as { id?: string }).id;
      const result = await client.query(
        clientId
          ? `INSERT INTO goals
              (id, user_id, container_id, name, goal_type, target_amount, current_amount, currency, target_date, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING *`
          : `INSERT INTO goals
              (user_id, container_id, name, goal_type, target_amount, current_amount, currency, target_date, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING *`,
        clientId
          ? [
              clientId,
              userId,
              dto.container_id || null,
              dto.name.trim(),
              dto.goal_type || 'other',
              dto.target_amount,
              dto.current_amount ?? 0,
              (dto.currency || baseCurrency).toUpperCase(),
              dto.target_date || null,
              dto.notes || null,
            ]
          : [
              userId,
              dto.container_id || null,
              dto.name.trim(),
              dto.goal_type || 'other',
              dto.target_amount,
              dto.current_amount ?? 0,
              (dto.currency || baseCurrency).toUpperCase(),
              dto.target_date || null,
              dto.notes || null,
            ],
      );
      return this.withProgress(client, userId, result.rows[0]);
    } catch (error: any) {
      if (error?.status === 400 || error?.status === 404) throw error;
      if (error?.code === '23505') {
        throw new BadRequestException('A goal with this name already exists.');
      }
      throw new BadRequestException(error.message || 'Failed to create goal');
    } finally {
      client.release();
    }
  }

  async findAll(userId: string) {
    const client = await this.pgPool.connect();
    try {
      const monthlySurplus = await this.monthlySurplus(client, userId);
      const result = await client.query(
        `SELECT g.*,
                fc.name AS container_name,
                fc.balance AS container_balance,
                fc.currency AS container_currency
         FROM goals g
         LEFT JOIN financial_containers fc
           ON fc.id = g.container_id AND fc.deleted_at IS NULL
         WHERE g.user_id = $1 AND g.deleted_at IS NULL
         ORDER BY g.target_date NULLS LAST, g.name ASC`,
        [userId],
      );
      const rows: any[] = [];
      for (const row of result.rows) {
        rows.push(await this.withProgress(client, userId, row, monthlySurplus));
      }
      return rows;
    } catch (error: any) {
      throw new BadRequestException(error.message || 'Failed to fetch goals');
    } finally {
      client.release();
    }
  }

  async findOne(userId: string, id: string) {
    const client = await this.pgPool.connect();
    try {
      const monthlySurplus = await this.monthlySurplus(client, userId);
      const result = await client.query(
        `SELECT g.*,
                fc.name AS container_name,
                fc.balance AS container_balance,
                fc.currency AS container_currency
         FROM goals g
         LEFT JOIN financial_containers fc
           ON fc.id = g.container_id AND fc.deleted_at IS NULL
         WHERE g.user_id = $1 AND g.id = $2 AND g.deleted_at IS NULL`,
        [userId, id],
      );
      if (!result.rowCount) {
        throw new NotFoundException('Goal not found');
      }
      return this.withProgress(client, userId, result.rows[0], monthlySurplus);
    } catch (error: any) {
      if (error?.status === 404) throw error;
      throw new BadRequestException(error.message || 'Failed to fetch goal');
    } finally {
      client.release();
    }
  }

  async update(userId: string, id: string, dto: UpdateGoalDto) {
    const client = await this.pgPool.connect();
    try {
      await this.findRaw(client, userId, id);
      if (dto.container_id) {
        await this.assertContainer(client, userId, dto.container_id);
      }

      const allowed = [
        'name',
        'goal_type',
        'target_amount',
        'current_amount',
        'currency',
        'target_date',
        'container_id',
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
        if (
          (key === 'container_id' || key === 'target_date') &&
          (value === '' || value === null)
        ) {
          value = null;
        }
        sets.push(`${key} = $${i++}`);
        values.push(value);
      }

      if (sets.length === 0) {
        return this.findOne(userId, id);
      }

      sets.push('updated_at = NOW()');
      values.push(id, userId);

      const result = await client.query(
        `UPDATE goals
         SET ${sets.join(', ')}
         WHERE id = $${i++} AND user_id = $${i} AND deleted_at IS NULL
         RETURNING id`,
        values,
      );
      if (!result.rowCount) {
        throw new NotFoundException('Goal not found');
      }
      return this.findOne(userId, id);
    } catch (error: any) {
      if (error?.status === 400 || error?.status === 404) throw error;
      if (error?.code === '23505') {
        throw new BadRequestException('A goal with this name already exists.');
      }
      throw new BadRequestException(error.message || 'Failed to update goal');
    } finally {
      client.release();
    }
  }

  async contribute(userId: string, id: string, dto: ContributeGoalDto) {
    const client = await this.pgPool.connect();
    try {
      const raw = await client.query(
        `SELECT g.*,
                fc.name AS container_name,
                fc.balance AS container_balance,
                fc.currency AS container_currency
         FROM goals g
         LEFT JOIN financial_containers fc
           ON fc.id = g.container_id AND fc.deleted_at IS NULL
         WHERE g.id = $1 AND g.user_id = $2 AND g.deleted_at IS NULL
         FOR UPDATE OF g`,
        [id, userId],
      );
      if (!raw.rowCount) {
        throw new NotFoundException('Goal not found');
      }
      if (raw.rows[0].container_id) {
        throw new BadRequestException(
          'This goal tracks a container balance. Add money to that account instead.',
        );
      }

      const next = Number(raw.rows[0].current_amount) + Number(dto.amount);
      const updated = await client.query(
        `UPDATE goals
         SET current_amount = $1, updated_at = NOW()
         WHERE id = $2 AND user_id = $3
         RETURNING *`,
        [next, id, userId],
      );
      const row = {
        ...updated.rows[0],
        container_name: raw.rows[0].container_name,
        container_balance: raw.rows[0].container_balance,
        container_currency: raw.rows[0].container_currency,
      };
      return this.withProgress(client, userId, row);
    } catch (error: any) {
      if (error?.status === 400 || error?.status === 404) throw error;
      throw new BadRequestException(
        error.message || 'Failed to contribute to goal',
      );
    } finally {
      client.release();
    }
  }

  async remove(userId: string, id: string) {
    const client = await this.pgPool.connect();
    try {
      const result = await client.query(
        `UPDATE goals
         SET deleted_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
         RETURNING id`,
        [id, userId],
      );
      if (!result.rowCount) {
        throw new NotFoundException('Goal not found');
      }
      return { id };
    } catch (error: any) {
      if (error?.status === 404) throw error;
      throw new BadRequestException(error.message || 'Failed to delete goal');
    } finally {
      client.release();
    }
  }

  private async findRaw(client: any, userId: string, id: string) {
    const result = await client.query(
      `SELECT id FROM goals
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [id, userId],
    );
    if (!result.rowCount) {
      throw new NotFoundException('Goal not found');
    }
  }

  private async assertContainer(
    client: any,
    userId: string,
    containerId: string,
  ) {
    const result = await client.query(
      `SELECT id FROM financial_containers
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [containerId, userId],
    );
    if (!result.rowCount) {
      throw new BadRequestException('Financial container not found');
    }
  }

  private async getUserCurrency(client: any, userId: string): Promise<string> {
    const result = await client.query(
      `SELECT currency FROM users WHERE id = $1`,
      [userId],
    );
    return (result.rows[0]?.currency || 'USD').toUpperCase();
  }

  /** Average monthly surplus from last 90 days of ledger (income − expense), in base currency. */
  private async monthlySurplus(client: any, userId: string): Promise<number> {
    const result = await client.query(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'income' THEN COALESCE(amount_base, amount) ELSE 0 END), 0)
         - COALESCE(SUM(CASE WHEN type = 'expense' THEN COALESCE(amount_base, amount) ELSE 0 END), 0)
           AS net
       FROM ledger_transactions
       WHERE user_id = $1
         AND deleted_at IS NULL
         AND type IN ('income', 'expense')
         AND date >= (CURRENT_DATE - INTERVAL '90 days')`,
      [userId],
    );
    const net90 = Number(result.rows[0]?.net || 0);
    return Math.round((net90 / 3 + Number.EPSILON) * 100) / 100;
  }

  private async withProgress(
    client: any,
    userId: string,
    row: any,
    monthlySurplus?: number,
  ) {
    const currency = String(row.currency || 'USD').toUpperCase();
    const target = Number(row.target_amount);
    let current = Number(row.current_amount || 0);
    let progressSource: 'manual' | 'container' = 'manual';

    if (row.container_id && row.container_balance != null) {
      const containerCurrency = String(
        row.container_currency || currency,
      ).toUpperCase();
      current = convertAmount(
        Number(row.container_balance),
        containerCurrency,
        currency,
      );
      progressSource = 'container';
    }

    const remaining = Math.max(
      0,
      Math.round((target - current + Number.EPSILON) * 100) / 100,
    );
    const percent =
      target > 0
        ? Math.round(((current / target) * 100 + Number.EPSILON) * 10) / 10
        : 0;

    let status: 'on_track' | 'behind' | 'achieved' | 'at_risk' = 'on_track';
    if (current >= target) status = 'achieved';

    const surplus =
      monthlySurplus !== undefined
        ? monthlySurplus
        : await this.monthlySurplus(client, userId);

    let predicted_date: string | null = null;
    if (status !== 'achieved' && surplus > 0 && remaining > 0) {
      const monthsNeeded = remaining / surplus;
      const predicted = new Date();
      predicted.setMonth(predicted.getMonth() + Math.ceil(monthsNeeded));
      predicted_date = this.isoDate(predicted);
    }

    if (status !== 'achieved' && row.target_date) {
      const targetOnly = requireDateOnly(row.target_date);
      const targetDate = new Date(`${targetOnly}T00:00:00`);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const daysLeft = Math.ceil(
        (targetDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
      );
      if (daysLeft < 0) {
        status = 'behind';
      } else if (surplus <= 0 && remaining > 0) {
        status = 'at_risk';
      } else if (predicted_date && predicted_date > targetOnly) {
        status = 'behind';
      }
    } else if (status !== 'achieved' && surplus <= 0 && remaining > 0) {
      status = 'at_risk';
    }

    return {
      id: row.id,
      user_id: row.user_id,
      container_id: row.container_id,
      container_name: row.container_name || null,
      name: row.name,
      goal_type: row.goal_type,
      target_amount: target,
      current_amount: current,
      stored_current_amount: Number(row.current_amount || 0),
      currency,
      target_date: toDateOnly(row.target_date),
      notes: row.notes,
      created_at: row.created_at,
      updated_at: row.updated_at,
      remaining,
      percent: Math.min(percent, 100),
      status,
      progress_source: progressSource,
      monthly_surplus: surplus,
      predicted_date,
    };
  }

  private isoDate(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
}
