import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Pool } from 'pg';
import { TransactionsService } from '../transactions/transactions.service';
import {
  CreateRecurringScheduleDto,
  UpdateRecurringScheduleDto,
} from './dto/recurring.dto';
import { requireDateOnly } from 'src/common/date/to-date-only';

@Injectable()
export class RecurringService {
  private processing = false;

  constructor(
    @Inject('PG_POOL') private readonly pgPool: Pool,
    private readonly transactionsService: TransactionsService,
  ) {}

  async create(userId: string, dto: CreateRecurringScheduleDto) {
    this.validateShape(dto);
    await this.assertContainers(userId, dto);
    if (dto.end_date && dto.end_date < dto.start_date) {
      throw new BadRequestException('End date cannot precede start date.');
    }
    const clientId = (dto as { id?: string }).id;
    const result = await this.pgPool.query(
      clientId
        ? `INSERT INTO recurring_schedules
            (id, user_id, name, transaction_type, amount, description, category_id,
             source_container_id, destination_container_id, currency, exchange_rate,
             frequency, start_date, end_date, next_execution, execution_mode, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$13,$15,$16)
           RETURNING id`
        : `INSERT INTO recurring_schedules
            (user_id, name, transaction_type, amount, description, category_id,
             source_container_id, destination_container_id, currency, exchange_rate,
             frequency, start_date, end_date, next_execution, execution_mode, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$12,$14,$15)
           RETURNING id`,
      clientId
        ? [
            clientId,
            userId,
            dto.name.trim(),
            dto.transaction_type,
            dto.amount,
            dto.description.trim(),
            dto.category_id || null,
            dto.source_container_id || null,
            dto.destination_container_id || null,
            dto.currency || null,
            dto.exchange_rate || null,
            dto.frequency,
            dto.start_date,
            dto.end_date || null,
            dto.execution_mode || 'review',
            dto.notes?.trim() || null,
          ]
        : [
            userId,
            dto.name.trim(),
            dto.transaction_type,
            dto.amount,
            dto.description.trim(),
            dto.category_id || null,
            dto.source_container_id || null,
            dto.destination_container_id || null,
            dto.currency || null,
            dto.exchange_rate || null,
            dto.frequency,
            dto.start_date,
            dto.end_date || null,
            dto.execution_mode || 'review',
            dto.notes?.trim() || null,
          ],
    );
    return this.findOne(userId, result.rows[0].id);
  }

  async findAll(userId: string) {
    const result = await this.pgPool.query(
      `${this.selectSql()}
       WHERE s.user_id = $1 AND s.deleted_at IS NULL
       ORDER BY
         CASE s.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
         s.next_execution ASC`,
      [userId],
    );
    return result.rows.map((row) => this.normalize(row));
  }

  async findOne(userId: string, id: string) {
    const result = await this.pgPool.query(
      `${this.selectSql()}
       WHERE s.user_id = $1 AND s.id = $2 AND s.deleted_at IS NULL`,
      [userId, id],
    );
    if (!result.rowCount) {
      throw new NotFoundException('Recurring schedule not found');
    }
    return this.normalize(result.rows[0]);
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateRecurringScheduleDto,
  ) {
    const current = await this.findOne(userId, id);
    const merged = { ...current, ...dto } as CreateRecurringScheduleDto;
    this.validateShape(merged);
    await this.assertContainers(userId, merged);
    if (merged.end_date && merged.end_date < merged.start_date) {
      throw new BadRequestException('End date cannot precede start date.');
    }
    const allowed = [
      'name',
      'transaction_type',
      'amount',
      'description',
      'category_id',
      'source_container_id',
      'destination_container_id',
      'currency',
      'exchange_rate',
      'frequency',
      'start_date',
      'end_date',
      'execution_mode',
      'status',
      'notes',
    ] as const;
    const fields = allowed.filter((field) => dto[field] !== undefined);
    if (!fields.length) throw new BadRequestException('No values to update');
    const values: unknown[] = fields.map((field) => dto[field] ?? null);
    values.push(userId, id);
    await this.pgPool.query(
      `UPDATE recurring_schedules
       SET ${fields.map((field, index) => `${field} = $${index + 1}`).join(', ')},
           last_error = CASE
             WHEN ${fields.includes('status') ? `'${dto.status}' = 'active'` : 'FALSE'}
             THEN NULL ELSE last_error END,
           updated_at = NOW()
       WHERE user_id = $${values.length - 1}
         AND id = $${values.length}
         AND deleted_at IS NULL`,
      values,
    );
    if (
      dto.start_date !== undefined &&
      dto.start_date !== current.start_date
    ) {
      // A moved start date re-anchors a schedule that hasn't run yet and must
      // never let it run before the new start.
      await this.pgPool.query(
        `UPDATE recurring_schedules
         SET next_execution = CASE
               WHEN NOT EXISTS (
                 SELECT 1 FROM recurring_executions
                 WHERE schedule_id = $2 AND status = 'successful'
               ) THEN start_date
               ELSE GREATEST(start_date, next_execution)
             END,
             updated_at = NOW()
         WHERE user_id = $1 AND id = $2`,
        [userId, id],
      );
    }
    return this.findOne(userId, id);
  }

  async archive(userId: string, id: string) {
    const result = await this.pgPool.query(
      `UPDATE recurring_schedules
       SET status = 'archived', deleted_at = NOW(), updated_at = NOW()
       WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL
       RETURNING id`,
      [userId, id],
    );
    if (!result.rowCount) {
      throw new NotFoundException('Recurring schedule not found');
    }
    return { id, archived: true };
  }

  async history(userId: string, id: string) {
    await this.findOne(userId, id);
    const result = await this.pgPool.query(
      `SELECT id, scheduled_for, transaction_id, status, error_message,
              created_at, completed_at
       FROM recurring_executions
       WHERE user_id = $1 AND schedule_id = $2
       ORDER BY scheduled_for DESC
       LIMIT 100`,
      [userId, id],
    );
    return result.rows.map((row) => ({
      ...row,
      scheduled_for: requireDateOnly(row.scheduled_for),
    }));
  }

  async execute(userId: string, id: string) {
    const schedule = await this.findOne(userId, id);
    if (schedule.status !== 'active') {
      throw new BadRequestException('Only active schedules can run.');
    }
    const today = await this.today();
    if (schedule.next_execution > today) {
      throw new BadRequestException(
        `This schedule is not due until ${schedule.next_execution}.`,
      );
    }
    const scheduledFor = schedule.next_execution;
    if (schedule.end_date && scheduledFor > schedule.end_date) {
      await this.pgPool.query(
        `UPDATE recurring_schedules
         SET status = 'completed', updated_at = NOW()
         WHERE id = $1 AND user_id = $2`,
        [id, userId],
      );
      return { completed: true, next_execution: scheduledFor };
    }

    // Claim the slot, post the transaction and advance the schedule in one
    // DB transaction so a crash can never leave a half-applied run behind.
    const client = await this.pgPool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT next_execution FROM recurring_schedules
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
           AND status = 'active'
         FOR UPDATE`,
        [id, userId],
      );
      if (
        !locked.rowCount ||
        requireDateOnly(locked.rows[0].next_execution) !== scheduledFor
      ) {
        // Another run advanced or paused this schedule meanwhile.
        await client.query('ROLLBACK');
        return { duplicate: true, scheduled_for: scheduledFor };
      }

      // Retry a previously failed slot instead of treating it as done.
      const execution = await client.query(
        `INSERT INTO recurring_executions
          (schedule_id, user_id, scheduled_for, status)
         VALUES ($1, $2, $3, 'pending')
         ON CONFLICT (schedule_id, scheduled_for) DO UPDATE
           SET status = 'pending', error_message = NULL, completed_at = NULL
           WHERE recurring_executions.status <> 'successful'
         RETURNING id`,
        [id, userId, scheduledFor],
      );
      const next = this.nextDate(
        scheduledFor,
        schedule.frequency,
        schedule.start_date,
      );
      const completed = Boolean(schedule.end_date && next > schedule.end_date);

      if (!execution.rowCount) {
        // Slot already posted successfully; just move the schedule on.
        await client.query(
          `UPDATE recurring_schedules
           SET next_execution = $3, status = $4, updated_at = NOW()
           WHERE id = $1 AND user_id = $2`,
          [id, userId, next, completed ? 'completed' : 'active'],
        );
        await client.query('COMMIT');
        return { duplicate: true, scheduled_for: scheduledFor };
      }
      const executionId = execution.rows[0].id;

      const transaction = await this.transactionsService.createWithClient(
        client,
        userId,
        {
          type: schedule.transaction_type,
          amount: schedule.amount,
          description: schedule.description,
          date: scheduledFor,
          category_id: schedule.category_id || undefined,
          source_container_id: schedule.source_container_id || undefined,
          destination_container_id:
            schedule.destination_container_id || undefined,
          currency: schedule.currency || undefined,
          exchange_rate: schedule.exchange_rate || undefined,
          notes: schedule.notes || `Generated by ${schedule.name}`,
        },
        'recurring',
      );
      await client.query(
        `UPDATE recurring_executions
         SET status = 'successful', transaction_id = $1, completed_at = NOW()
         WHERE id = $2`,
        [transaction.id, executionId],
      );
      await client.query(
        `UPDATE recurring_schedules
         SET next_execution = $3,
             status = $4,
             last_error = NULL,
             updated_at = NOW()
         WHERE id = $1 AND user_id = $2`,
        [id, userId, next, completed ? 'completed' : 'active'],
      );
      await client.query('COMMIT');
      return { transaction, next_execution: next, completed };
    } catch (error: any) {
      await client.query('ROLLBACK').catch(() => undefined);
      const message = error?.message || 'Recurring execution failed';
      await this.pgPool.query(
        `INSERT INTO recurring_executions
          (schedule_id, user_id, scheduled_for, status, error_message, completed_at)
         VALUES ($1, $2, $3, 'failed', $4, NOW())
         ON CONFLICT (schedule_id, scheduled_for) DO UPDATE
           SET status = 'failed', error_message = EXCLUDED.error_message,
               completed_at = NOW()
           WHERE recurring_executions.status <> 'successful'`,
        [id, userId, scheduledFor, message],
      );
      await this.pgPool.query(
        `UPDATE recurring_schedules
         SET status = 'paused', last_error = $1, updated_at = NOW()
         WHERE id = $2 AND user_id = $3`,
        [message, id, userId],
      );
      throw new BadRequestException(
        `${message} The schedule was paused for review.`,
      );
    } finally {
      client.release();
    }
  }

  @Interval(60_000)
  async processDueSchedules() {
    if (this.processing) return;
    this.processing = true;
    try {
      const due = await this.pgPool.query(
        `SELECT id, user_id
         FROM recurring_schedules
         WHERE status = 'active'
           AND execution_mode = 'automatic'
           AND deleted_at IS NULL
           AND next_execution <= CURRENT_DATE
         ORDER BY next_execution
         LIMIT 25`,
      );
      for (const row of due.rows) {
        try {
          await this.execute(row.user_id, row.id);
        } catch {
          // execute records the error and pauses unsafe schedules.
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private selectSql() {
    return `SELECT
      s.*,
      sc.name AS source_name,
      dc.name AS destination_name,
      c.name AS category_name
    FROM recurring_schedules s
    LEFT JOIN financial_containers sc ON sc.id = s.source_container_id
    LEFT JOIN financial_containers dc ON dc.id = s.destination_container_id
    LEFT JOIN categories c ON c.id = s.category_id`;
  }

  private normalize(row: Record<string, any>): Record<string, any> {
    return {
      ...row,
      amount: Number(row.amount),
      exchange_rate: row.exchange_rate
        ? Number(row.exchange_rate)
        : null,
      start_date: requireDateOnly(row.start_date),
      end_date: row.end_date ? requireDateOnly(row.end_date) : null,
      next_execution: requireDateOnly(row.next_execution),
    };
  }

  private validateShape(dto: CreateRecurringScheduleDto) {
    if (dto.transaction_type === 'expense' && !dto.source_container_id) {
      throw new BadRequestException('Expense schedule requires a source.');
    }
    if (dto.transaction_type === 'income' && !dto.destination_container_id) {
      throw new BadRequestException('Income schedule requires a destination.');
    }
    if (dto.transaction_type === 'transfer') {
      if (!dto.source_container_id || !dto.destination_container_id) {
        throw new BadRequestException(
          'Transfer schedule requires source and destination.',
        );
      }
      if (dto.source_container_id === dto.destination_container_id) {
        throw new BadRequestException(
          'Schedule source and destination must differ.',
        );
      }
    }
  }

  private async assertContainers(
    userId: string,
    dto: CreateRecurringScheduleDto,
  ) {
    const ids = [
      dto.source_container_id,
      dto.destination_container_id,
    ].filter(Boolean);
    if (!ids.length) return;
    const result = await this.pgPool.query(
      `SELECT id FROM financial_containers
       WHERE user_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
      [userId, ids],
    );
    if (result.rowCount !== new Set(ids).size) {
      throw new BadRequestException(
        'One or more schedule containers are unavailable.',
      );
    }
  }

  /** Use the DB calendar date so it matches the scheduler's CURRENT_DATE. */
  private async today(): Promise<string> {
    const result = await this.pgPool.query(
      `SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today`,
    );
    return result.rows[0].today;
  }

  /**
   * Next run date. Month-based frequencies stay anchored to the start date's
   * day and clamp to month end (Jan 31, Feb 28, Mar 31), so they never drift
   * or skip a month.
   */
  private nextDate(value: string, frequency: string, anchor: string) {
    const [y, m, d] = value.split('-').map(Number);
    const anchorDay = Number(String(anchor).slice(8, 10)) || d;
    const addMonths = (n: number) => {
      const lastDay = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
      return new Date(Date.UTC(y, m - 1 + n, Math.min(anchorDay, lastDay)));
    };
    let date: Date;
    if (frequency === 'daily') date = new Date(Date.UTC(y, m - 1, d + 1));
    else if (frequency === 'weekly') date = new Date(Date.UTC(y, m - 1, d + 7));
    else if (frequency === 'biweekly')
      date = new Date(Date.UTC(y, m - 1, d + 14));
    else if (frequency === 'monthly') date = addMonths(1);
    else if (frequency === 'quarterly') date = addMonths(3);
    else if (frequency === 'semiannual') date = addMonths(6);
    else date = addMonths(12);
    return date.toISOString().slice(0, 10);
  }
}
