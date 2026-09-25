import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  forwardRef,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Pool } from 'pg';
import { AiAdvisorService } from '../ai-advisor/ai-advisor.service';
import { isMailConfigured, sendMail } from 'src/utils/mail/mail.util';
import { ReportsService } from './reports.service';
import { buildPeriodWorkbook } from './report-excel.util';
import {
  buildPeriodReportEmail,
  heuristicInsights,
} from './report-email.util';
import { UpdateReportScheduleDto } from './dto/report-schedule.dto';
import {
  DEFAULT_REPORT_SCHEDULE,
  isReportDue,
  nextSendAt,
  normalizeSchedule,
  periodBounds,
  periodLabel,
  scheduleSummary,
  zonedNow,
  type ReportSchedule,
} from './report-schedule';

type ScheduleRow = ReportSchedule & {
  last_sent_at: Date | null;
  last_period_key: string | null;
  last_error: string | null;
};

@Injectable()
export class ReportDispatchService {
  private readonly logger = new Logger(ReportDispatchService.name);
  private processing = false;

  constructor(
    @Inject('PG_POOL') private readonly pgPool: Pool,
    private readonly reports: ReportsService,
    @Inject(forwardRef(() => AiAdvisorService))
    private readonly advisor: AiAdvisorService,
  ) {}

  async getSchedule(userId: string) {
    const user = await this.loadUser(userId);
    const schedule = await this.loadSchedule(userId);
    const local = zonedNow(new Date(), user.timezone);
    const bounds = periodBounds(schedule, local);
    return {
      ...schedule,
      timezone: user.timezone,
      summary: scheduleSummary(schedule, user.timezone),
      next_send_at: nextSendAt(
        schedule,
        user.timezone,
        new Date(),
        schedule.last_sent_at,
        user.created_at,
        schedule.last_period_key,
      ),
      current_period: {
        start: bounds.start,
        end: bounds.end,
        label: periodLabel(bounds.start, bounds.end),
      },
      last_sent_at: schedule.last_sent_at,
      last_error: schedule.last_error,
      default_note:
        'If you never change this, Opal emails a report every Saturday at 10:00 in your timezone.',
    };
  }

  async saveSchedule(userId: string, dto: UpdateReportScheduleDto) {
    const current = await this.loadSchedule(userId);
    const next = normalizeSchedule({ ...current, ...dto });
    await this.pgPool.query(
      `INSERT INTO user_report_schedules (
          user_id, enabled, frequency, weekday, monthly_mode, day_of_month,
          custom_mode, interval_days, custom_dates, send_time,
          include_excel, include_ai, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date[],$10::time,$11,$12,NOW())
        ON CONFLICT (user_id) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          frequency = EXCLUDED.frequency,
          weekday = EXCLUDED.weekday,
          monthly_mode = EXCLUDED.monthly_mode,
          day_of_month = EXCLUDED.day_of_month,
          custom_mode = EXCLUDED.custom_mode,
          interval_days = EXCLUDED.interval_days,
          custom_dates = EXCLUDED.custom_dates,
          send_time = EXCLUDED.send_time,
          include_excel = EXCLUDED.include_excel,
          include_ai = EXCLUDED.include_ai,
          updated_at = NOW()`,
      [
        userId,
        next.enabled,
        next.frequency,
        next.weekday,
        next.monthly_mode,
        next.day_of_month,
        next.custom_mode,
        next.interval_days,
        next.custom_dates,
        `${next.send_time}:00`,
        next.include_excel,
        next.include_ai,
      ],
    );
    return this.getSchedule(userId);
  }

  async sendNow(userId: string) {
    const user = await this.loadUser(userId);
    const schedule = await this.loadSchedule(userId);
    const local = zonedNow(new Date(), user.timezone);
    const bounds = periodBounds(schedule, local);
    const key = `manual:${local.isoDate}:${Date.now()}`;
    await this.deliver({
      userId,
      email: user.email,
      fullName: user.full_name,
      timezone: user.timezone,
      schedule,
      start: bounds.start,
      end: bounds.end,
            periodKey: key,
          });
    return {
      sent: true,
      period: { start: bounds.start, end: bounds.end },
    };
  }

  @Interval(60_000)
  async processDueReports() {
    if (this.processing) return;
    if (!isMailConfigured()) return;
    this.processing = true;
    try {
      const users = await this.pgPool.query(
        `SELECT u.id, u.email, u.full_name, u.timezone, u.created_at,
                s.enabled, s.frequency, s.weekday, s.monthly_mode, s.day_of_month,
                s.custom_mode, s.interval_days, s.custom_dates, s.send_time,
                s.include_excel, s.include_ai, s.last_sent_at, s.last_period_key
         FROM users u
         LEFT JOIN user_report_schedules s ON s.user_id = u.id
         WHERE u.deleted_at IS NULL
           AND COALESCE(u.is_delete, false) = false
           AND COALESCE(u.is_active, true) = true
           AND u.email IS NOT NULL
           AND u.email <> ''
           AND COALESCE(u.email_verified, true) = true
           AND COALESCE(s.enabled, true) = true
         ORDER BY s.last_sent_at NULLS FIRST, u.created_at ASC
         LIMIT 80`,
      );
      for (const row of users.rows) {
        const schedule = this.rowToSchedule(row);
        const due = isReportDue({
          schedule,
          timeZone: row.timezone,
          lastPeriodKey: row.last_period_key,
          lastSentAt: row.last_sent_at,
          createdAt: row.created_at,
        });
        if (!due.due) continue;
        try {
          await this.deliver({
            userId: row.id,
            email: row.email,
            fullName: row.full_name,
            timezone: row.timezone,
            schedule,
            start: due.start,
            end: due.end,
            periodKey: due.periodKey,
          });
        } catch (error: any) {
          const message = error?.message || 'Failed to send report';
          this.logger.warn(`Report email failed for ${row.id}: ${message}`);
          await this.recordError(row.id, message);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private async deliver(input: {
    userId: string;
    email: string;
    fullName: string | null;
    timezone: string | null;
    schedule: ScheduleRow;
    start: string;
    end: string;
    periodKey: string;
  }) {
    if (!isMailConfigured()) {
      throw new BadRequestException(
        'Mail is not configured, so the report cannot be emailed yet.',
      );
    }
    const snapshot = await this.reports.periodReport(
      input.userId,
      input.start,
      input.end,
      periodLabel(input.start, input.end),
      input.schedule.frequency,
    );
    let insights = heuristicInsights(snapshot);
    if (input.schedule.include_ai) {
      const ai = await this.advisor.generatePeriodInsights(input.userId, snapshot);
      if (ai?.trim()) insights = ai.trim();
    }
    const { html, text } = buildPeriodReportEmail({
      snapshot,
      insights,
      includeExcel: input.schedule.include_excel,
    });
    const attachments = input.schedule.include_excel
      ? [
          {
            filename: `opal-report-${input.start}-to-${input.end}.xlsx`,
            content: await buildPeriodWorkbook(snapshot),
            contentType:
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          },
        ]
      : undefined;
    const cadence =
      input.schedule.frequency === 'custom'
        ? 'custom'
        : input.schedule.frequency;
    await sendMail({
      to: input.email,
      subject: `Opal ${cadence} report · ${periodLabel(input.start, input.end)}`,
      text,
      html,
      attachments,
    });
    await this.pgPool.query(
      `INSERT INTO user_report_schedules (
          user_id, last_sent_at, last_period_key, last_error, updated_at
        ) VALUES ($1, NOW(), $2, NULL, NOW())
        ON CONFLICT (user_id) DO UPDATE SET
          last_sent_at = NOW(),
          last_period_key = EXCLUDED.last_period_key,
          last_error = NULL,
          updated_at = NOW()`,
      [input.userId, input.periodKey],
    );
  }

  private async recordError(userId: string, message: string) {
    await this.pgPool.query(
      `INSERT INTO user_report_schedules (user_id, last_error, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         last_error = EXCLUDED.last_error,
         updated_at = NOW()`,
      [userId, message.slice(0, 500)],
    );
  }

  private async loadUser(userId: string) {
    const result = await this.pgPool.query(
      `SELECT id, email, full_name, timezone, created_at, email_verified
       FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    if (!result.rowCount) throw new BadRequestException('User not found');
    const row = result.rows[0];
    if (!row.email) {
      throw new BadRequestException('Add an email address before sending reports.');
    }
    return row as {
      id: string;
      email: string;
      full_name: string | null;
      timezone: string | null;
      created_at: Date;
      email_verified: boolean;
    };
  }

  private async loadSchedule(userId: string): Promise<ScheduleRow> {
    const result = await this.pgPool.query(
      `SELECT * FROM user_report_schedules WHERE user_id = $1`,
      [userId],
    );
    if (!result.rowCount) {
      return {
        ...DEFAULT_REPORT_SCHEDULE,
        last_sent_at: null,
        last_period_key: null,
        last_error: null,
      };
    }
    return this.rowToSchedule(result.rows[0]);
  }

  private rowToSchedule(row: any): ScheduleRow {
    const sendTime = String(row.send_time || '10:00:00').slice(0, 5);
    const dates = Array.isArray(row.custom_dates)
      ? row.custom_dates.map((value: Date | string) =>
          String(value).slice(0, 10),
        )
      : [];
    return {
      ...normalizeSchedule({
        enabled: row.enabled ?? DEFAULT_REPORT_SCHEDULE.enabled,
        frequency: row.frequency,
        weekday: row.weekday,
        monthly_mode: row.monthly_mode,
        day_of_month: row.day_of_month,
        custom_mode: row.custom_mode,
        interval_days: row.interval_days,
        custom_dates: dates,
        send_time: sendTime,
        include_excel: row.include_excel,
        include_ai: row.include_ai,
      }),
      last_sent_at: row.last_sent_at || null,
      last_period_key: row.last_period_key || null,
      last_error: row.last_error || null,
    };
  }
}
