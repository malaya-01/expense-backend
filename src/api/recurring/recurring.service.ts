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
    const today = this.today();
    if (schedule.next_execution > today) {
      throw new BadRequestException(
        `This schedule is not due until ${schedule.next_execution}.`,
      );
    }
    const scheduledFor = schedule.next_execution;
    let executionId: string;
    try {
      const execution = await this.pgPool.query(
        `INSERT INTO recurring_executions
          (schedule_id, user_id, scheduled_for, status)
         VALUES ($1, $2, $3, 'pending')
         RETURNING id`,
        [id, userId, scheduledFor],
      );
      executionId = execution.rows[0].id;
    } catch (error: any) {
      if (error?.code === '23505') {
        return { duplicate: true, scheduled_for: scheduledFor };
      }
      throw error;
    }

    try {
      const transaction = await this.transactionsService.create(userId, {
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
      });
      const next = this.nextDate(scheduledFor, schedule.frequency);
      const completed = schedule.end_date && next > schedule.end_date;
      await this.pgPool.query(
        `UPDATE recurring_executions
         SET status = 'successful', transaction_id = $1, completed_at = NOW()
         WHERE id = $2`,
        [transaction.id, executionId],
      );
      await this.pgPool.query(
        `UPDATE recurring_schedules
         SET next_execution = $3,
             status = $4,
             last_error = NULL,
             updated_at = NOW()
         WHERE id = $1 AND user_id = $2`,
        [
          id,
          userId,
          next,
          completed ? 'completed' : 'active',
        ],
      );
      return { transaction, next_execution: next, completed };
    } catch (error: any) {
      const message = error?.message || 'Recurring execution failed';
      await this.pgPool.query(
        `UPDATE recurring_executions
         SET status = 'failed', error_message = $1, completed_at = NOW()
         WHERE id = $2`,
        [message, executionId],
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

  private today() {
    const now = new Date();
    return [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('-');
  }

  private nextDate(value: string, frequency: string) {
    const date = new Date(`${value}T00:00:00Z`);
    if (frequency === 'daily') date.setUTCDate(date.getUTCDate() + 1);
    else if (frequency === 'weekly') date.setUTCDate(date.getUTCDate() + 7);
    else if (frequency === 'biweekly') date.setUTCDate(date.getUTCDate() + 14);
    else if (frequency === 'monthly') date.setUTCMonth(date.getUTCMonth() + 1);
    else if (frequency === 'quarterly')
      date.setUTCMonth(date.getUTCMonth() + 3);
    else if (frequency === 'semiannual')
      date.setUTCMonth(date.getUTCMonth() + 6);
    else date.setUTCFullYear(date.getUTCFullYear() + 1);
    return date.toISOString().slice(0, 10);
  }
}
