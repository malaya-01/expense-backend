export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export type ReportFrequency = 'weekly' | 'monthly' | 'custom';
export type MonthlyMode = 'last_day' | 'day_of_month';
export type CustomMode = 'interval' | 'dates';

export type ReportSchedule = {
  enabled: boolean;
  frequency: ReportFrequency;
  weekday: number;
  monthly_mode: MonthlyMode;
  day_of_month: number;
  custom_mode: CustomMode;
  interval_days: number;
  custom_dates: string[];
  send_time: string;
  include_excel: boolean;
  include_ai: boolean;
};

export const DEFAULT_REPORT_SCHEDULE: ReportSchedule = {
  enabled: true,
  frequency: 'weekly',
  weekday: 6,
  monthly_mode: 'last_day',
  day_of_month: 1,
  custom_mode: 'interval',
  interval_days: 14,
  custom_dates: [],
  send_time: '10:00',
  include_excel: true,
  include_ai: true,
};

export type ZonedDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
  isoDate: string;
};

function pad(value: number) {
  return String(value).padStart(2, '0');
}

export function isoDate(year: number, month: number, day: number) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function addDaysIso(iso: string, days: number) {
  const [y, m, d] = iso.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d + days));
  return isoDate(utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate());
}

export function lastDayOfMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function diffDaysInclusive(start: string, end: string) {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

export function parseSendTime(value: string): { hour: number; minute: number } {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) return { hour: 10, minute: 0 };
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2])));
  return { hour, minute };
}

export function formatSendTime(hour: number, minute: number) {
  return `${pad(hour)}:${pad(minute)}`;
}

function safeTimeZone(timeZone: string | null | undefined) {
  const tz = (timeZone || 'UTC').trim() || 'UTC';
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    return 'UTC';
  }
}

export function zonedNow(
  date = new Date(),
  timeZone?: string | null,
): ZonedDateTime {
  const tz = safeTimeZone(timeZone);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const weekdayName = String(parts.weekday || '');
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    year,
    month,
    day,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: weekdayMap[weekdayName] ?? 0,
    isoDate: isoDate(year, month, day),
  };
}

export function normalizeSchedule(
  input?: Partial<ReportSchedule> | null,
): ReportSchedule {
  const src = input || {};
  const frequency: ReportFrequency =
    src.frequency === 'monthly' || src.frequency === 'custom'
      ? src.frequency
      : 'weekly';
  const weekday = Number.isFinite(Number(src.weekday))
    ? Math.min(6, Math.max(0, Math.round(Number(src.weekday))))
    : DEFAULT_REPORT_SCHEDULE.weekday;
  const monthly_mode: MonthlyMode =
    src.monthly_mode === 'day_of_month' ? 'day_of_month' : 'last_day';
  const day_of_month = Number.isFinite(Number(src.day_of_month))
    ? Math.min(28, Math.max(1, Math.round(Number(src.day_of_month))))
    : 1;
  const custom_mode: CustomMode =
    src.custom_mode === 'dates' ? 'dates' : 'interval';
  const interval_days = Number.isFinite(Number(src.interval_days))
    ? Math.min(365, Math.max(1, Math.round(Number(src.interval_days))))
    : 14;
  const custom_dates = Array.isArray(src.custom_dates)
    ? [...new Set(
        src.custom_dates
          .map((value) => String(value || '').slice(0, 10))
          .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)),
      )].sort()
    : [];
  const parsedTime = parseSendTime(src.send_time || DEFAULT_REPORT_SCHEDULE.send_time);
  return {
    enabled: src.enabled !== false,
    frequency,
    weekday,
    monthly_mode,
    day_of_month,
    custom_mode,
    interval_days,
    custom_dates,
    send_time: formatSendTime(parsedTime.hour, parsedTime.minute),
    include_excel: src.include_excel !== false,
    include_ai: src.include_ai !== false,
  };
}

export function periodKey(schedule: ReportSchedule, local: ZonedDateTime) {
  if (schedule.frequency === 'weekly') {
    return `weekly:${local.isoDate}`;
  }
  if (schedule.frequency === 'monthly') {
    return `monthly:${local.year}-${pad(local.month)}-${local.isoDate}`;
  }
  if (schedule.custom_mode === 'dates') {
    return `custom-date:${local.isoDate}`;
  }
  return `interval:${local.isoDate}`;
}

export function periodBounds(
  schedule: ReportSchedule,
  local: ZonedDateTime,
): { start: string; end: string } {
  const end = local.isoDate;
  if (schedule.frequency === 'weekly') {
    return { start: addDaysIso(end, -6), end };
  }
  if (schedule.frequency === 'monthly') {
    if (
      schedule.monthly_mode === 'day_of_month' &&
      local.day === schedule.day_of_month &&
      schedule.day_of_month <= 3
    ) {
      const prevMonth = local.month === 1 ? 12 : local.month - 1;
      const prevYear = local.month === 1 ? local.year - 1 : local.year;
      const last = lastDayOfMonth(prevYear, prevMonth);
      return {
        start: isoDate(prevYear, prevMonth, 1),
        end: isoDate(prevYear, prevMonth, last),
      };
    }
    return { start: isoDate(local.year, local.month, 1), end };
  }
  if (schedule.custom_mode === 'interval') {
    return { start: addDaysIso(end, -(schedule.interval_days - 1)), end };
  }
  const prior = schedule.custom_dates.filter((d) => d < end).pop();
  return { start: prior ? addDaysIso(prior, 1) : addDaysIso(end, -29), end };
}

function isScheduledDay(
  schedule: ReportSchedule,
  local: ZonedDateTime,
  lastSentAt: Date | null,
  createdAt: Date | null,
  timeZone?: string | null,
) {
  if (schedule.frequency === 'weekly') {
    return local.weekday === schedule.weekday;
  }
  if (schedule.frequency === 'monthly') {
    if (schedule.monthly_mode === 'last_day') {
      return local.day === lastDayOfMonth(local.year, local.month);
    }
    return local.day === schedule.day_of_month;
  }
  if (schedule.custom_mode === 'dates') {
    return schedule.custom_dates.includes(local.isoDate);
  }
  const anchor = lastSentAt || createdAt;
  if (!anchor) return false;
  const anchorLocal = zonedNow(anchor, timeZone);
  const elapsed = diffDaysInclusive(anchorLocal.isoDate, local.isoDate) - 1;
  return elapsed >= schedule.interval_days;
}

function timeReached(local: ZonedDateTime, sendTime: string) {
  const { hour, minute } = parseSendTime(sendTime);
  return local.hour > hour || (local.hour === hour && local.minute >= minute);
}

export function isReportDue(params: {
  schedule: ReportSchedule;
  timeZone?: string | null;
  lastPeriodKey?: string | null;
  lastSentAt?: Date | string | null;
  createdAt?: Date | string | null;
  now?: Date;
}) {
  const schedule = normalizeSchedule(params.schedule);
  if (!schedule.enabled) {
    return { due: false as const, reason: 'disabled' };
  }
  const local = zonedNow(params.now, params.timeZone);
  if (!isScheduledDay(
    schedule,
    local,
    params.lastSentAt ? new Date(params.lastSentAt) : null,
    params.createdAt ? new Date(params.createdAt) : null,
    params.timeZone,
  )) {
    return { due: false as const, reason: 'not-scheduled-day', local };
  }
  if (!timeReached(local, schedule.send_time)) {
    return { due: false as const, reason: 'before-send-time', local };
  }
  const key = periodKey(schedule, local);
  if (params.lastPeriodKey === key) {
    return { due: false as const, reason: 'already-sent', local, periodKey: key };
  }
  const bounds = periodBounds(schedule, local);
  return {
    due: true as const,
    local,
    periodKey: key,
    start: bounds.start,
    end: bounds.end,
  };
}

export function nextSendAt(
  schedule: ReportSchedule,
  timeZone?: string | null,
  now = new Date(),
  lastSentAt?: Date | string | null,
  createdAt?: Date | string | null,
  lastPeriodKey?: string | null,
): string | null {
  const normalized = normalizeSchedule(schedule);
  if (!normalized.enabled) return null;
  const { hour, minute } = parseSendTime(normalized.send_time);
  for (let i = 0; i < 420; i++) {
    const candidate = new Date(now.getTime() + i * 86_400_000);
    const local = zonedNow(candidate, timeZone);
    const scheduled = isScheduledDay(
      normalized,
      local,
      lastSentAt ? new Date(lastSentAt) : null,
      createdAt ? new Date(createdAt) : now,
      timeZone,
    );
    if (!scheduled) continue;
    if (lastPeriodKey && lastPeriodKey === periodKey(normalized, local)) continue;
    if (i === 0 && !timeReached(local, normalized.send_time)) {
      return `${local.isoDate}T${formatSendTime(hour, minute)}:00`;
    }
    if (i === 0 && timeReached(local, normalized.send_time)) {
      return `${local.isoDate}T${formatSendTime(hour, minute)}:00`;
    }
    return `${local.isoDate}T${formatSendTime(hour, minute)}:00`;
  }
  return null;
}

export function periodLabel(start: string, end: string) {
  if (start === end) return start;
  return `${start} to ${end}`;
}

export function scheduleSummary(schedule: ReportSchedule, timeZone?: string | null) {
  const tz = safeTimeZone(timeZone);
  const time = schedule.send_time;
  if (schedule.frequency === 'weekly') {
    return `Every ${WEEKDAYS[schedule.weekday]} at ${time} (${tz})`;
  }
  if (schedule.frequency === 'monthly') {
    if (schedule.monthly_mode === 'last_day') {
      return `Last day of each month at ${time} (${tz})`;
    }
    return `Day ${schedule.day_of_month} of each month at ${time} (${tz})`;
  }
  if (schedule.custom_mode === 'interval') {
    return `Every ${schedule.interval_days} day${schedule.interval_days === 1 ? '' : 's'} at ${time} (${tz})`;
  }
  if (!schedule.custom_dates.length) {
    return `On chosen dates at ${time} (${tz}) — add at least one date`;
  }
  return `On ${schedule.custom_dates.length} chosen date${schedule.custom_dates.length === 1 ? '' : 's'} at ${time} (${tz})`;
}
