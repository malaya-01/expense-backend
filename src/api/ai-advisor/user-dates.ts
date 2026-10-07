/**
 * Calendar-date helpers that work in the USER's timezone (users.timezone),
 * never the server's. Pure: no Nest / DB imports.
 */

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

/**
 * users.timezone defaults to 'UTC' and is rarely set. For currencies used in
 * a single timezone, that is a far better guess than UTC (INR → IST is +5:30,
 * enough to make "yesterday" wrong for a third of the day).
 */
const SINGLE_TZ_BY_CURRENCY: Record<string, string> = {
  INR: 'Asia/Kolkata',
  NPR: 'Asia/Kathmandu',
  LKR: 'Asia/Colombo',
  BDT: 'Asia/Dhaka',
  PKR: 'Asia/Karachi',
  AED: 'Asia/Dubai',
  SAR: 'Asia/Riyadh',
  SGD: 'Asia/Singapore',
  MYR: 'Asia/Kuala_Lumpur',
  PHP: 'Asia/Manila',
  THB: 'Asia/Bangkok',
  VND: 'Asia/Ho_Chi_Minh',
  JPY: 'Asia/Tokyo',
  KRW: 'Asia/Seoul',
  HKD: 'Asia/Hong_Kong',
  CNY: 'Asia/Shanghai',
  GBP: 'Europe/London',
  NZD: 'Pacific/Auckland',
  ZAR: 'Africa/Johannesburg',
  KES: 'Africa/Nairobi',
  NGN: 'Africa/Lagos',
  GHS: 'Africa/Accra',
  EGP: 'Africa/Cairo',
  ILS: 'Asia/Jerusalem',
  TRY: 'Europe/Istanbul',
};

/** Currencies whose receipts / users usually write MM/DD/YYYY. */
const MONTH_FIRST_CURRENCIES = new Set(['USD']);

export function isValidTimeZone(timeZone: string | null | undefined): boolean {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function effectiveTimeZone(
  stored: string | null | undefined,
  currency?: string | null,
): string {
  const tz = String(stored || '').trim();
  if (tz && !/^(utc|etc\/utc|gmt|z)$/i.test(tz) && isValidTimeZone(tz)) {
    return tz;
  }
  return SINGLE_TZ_BY_CURRENCY[String(currency || '').toUpperCase()] || 'UTC';
}

export function prefersMonthFirst(currency?: string | null): boolean {
  return MONTH_FIRST_CURRENCIES.has(String(currency || '').toUpperCase());
}

export type ZonedNow = {
  date: string;
  time: string;
  weekday: string;
  weekdayIndex: number;
  timeZone: string;
};

export function zonedNow(timeZone: string, now: Date = new Date()): ZonedNow {
  const tz = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'long',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || '';
  const weekday = get('weekday').toLowerCase();
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour').padStart(2, '0')}:${get('minute')}`,
    weekday,
    weekdayIndex: Math.max(0, WEEKDAYS.indexOf(weekday)),
    timeZone: tz,
  };
}

export function todayInTimeZone(timeZone: string, now: Date = new Date()): string {
  return zonedNow(timeZone, now).date;
}

/** Valid YYYY-MM-DD (calendar-checked) or null. Accepts ISO datetimes. */
export function normalizeIsoDate(value: unknown): string | null {
  const match = String(value ?? '')
    .trim()
    .match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T\s])/);
  if (!match) return null;
  return isoFromParts(Number(match[1]), Number(match[2]), Number(match[3]));
}

export function isoFromParts(year: number, month: number, day: number): string | null {
  if (!year || !month || !day) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

export function diffDaysIso(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round(
    (Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86_400_000,
  );
}

function expandYear(raw: string | undefined, today: string): number | null {
  if (!raw) return null;
  if (raw.length === 4) return Number(raw);
  if (raw.length === 2) return 2000 + Number(raw);
  return null;
}

/** Month/day without a year: this year, or last year when that is in the future. */
function inferYear(month: number, day: number, today: string): string | null {
  const year = Number(today.slice(0, 4));
  const candidate = isoFromParts(year, month, day);
  if (!candidate) return null;
  return diffDaysIso(candidate, today) > 1
    ? isoFromParts(year - 1, month, day)
    : candidate;
}

export type DateExpression = {
  text: string;
  date: string;
  relative: boolean;
};

export type DateContext = {
  timeZone: string;
  now?: Date;
  /** Read "05/10/2026" as May 10 instead of 5 Oct. */
  monthFirst?: boolean;
};

/**
 * Find every date expression in free text, resolved against "today" in the
 * user's timezone: today/yesterday/day before yesterday, N days/weeks ago,
 * last/this/on <weekday>, last week, ISO dates, "5 Oct", "Oct 5th 2026",
 * and numeric d/m(/y) dates.
 */
export function findDateExpressions(
  text: string,
  context: DateContext,
): DateExpression[] {
  const source = String(text || '');
  const lower = source.toLowerCase();
  const now = zonedNow(context.timeZone, context.now);
  const today = now.date;
  const found: Array<DateExpression & { index: number }> = [];
  const push = (index: number, raw: string, date: string | null, relative: boolean) => {
    if (date) found.push({ index, text: raw, date, relative });
  };

  let m: RegExpExecArray | null;
  const scan = (re: RegExp, handler: (match: RegExpExecArray) => void) => {
    re.lastIndex = 0;
    while ((m = re.exec(lower))) handler(m);
  };

  scan(/\bday before yesterday\b/g, (x) => push(x.index, x[0], addDaysIso(today, -2), true));
  scan(/\b(?<!before )yesterday\b|\blast night\b/g, (x) =>
    push(x.index, x[0], addDaysIso(today, -1), true),
  );
  scan(/\b(today|tonight|this (?:morning|afternoon|evening)|just now)\b/g, (x) =>
    push(x.index, x[0], today, true),
  );
  scan(
    /\b(\d{1,2}|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(day|days|week|weeks)\s+ago\b/g,
    (x) => {
      const n = /^\d+$/.test(x[1]) ? Number(x[1]) : NUMBER_WORDS[x[1]] || 0;
      const days = x[2].startsWith('week') ? n * 7 : n;
      push(x.index, x[0], addDaysIso(today, -days), true);
    },
  );
  scan(/\blast week\b/g, (x) => push(x.index, x[0], addDaysIso(today, -7), true));
  scan(
    /\b(last|past|previous|this|on)?\s*(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|sday|urday|rsday)?\b/g,
    (x) => {
      const key = x[2].slice(0, 3);
      const target = WEEKDAYS.findIndex((d) => d.startsWith(key));
      if (target < 0) return;
      // A bare "sat"/"sun"/"wed" without "on/last/this" is too ambiguous.
      if (!x[1] && x[0].trim().length <= 4) return;
      const qualifier = x[1] || 'on';
      let back = (now.weekdayIndex - target + 7) % 7;
      if ((qualifier === 'last' || qualifier === 'past' || qualifier === 'previous') && back === 0) {
        back = 7;
      }
      push(x.index, x[0].trim(), addDaysIso(today, -back), true);
    },
  );
  scan(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, (x) =>
    push(x.index, x[0], isoFromParts(Number(x[1]), Number(x[2]), Number(x[3])), false),
  );
  scan(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sept|sep|oct|nov|dec)[a-z]*\.?,?(?:\s+(\d{4}))?\b/g,
    (x) => {
      const month = MONTHS[x[2]];
      const day = Number(x[1]);
      const date = x[3] ? isoFromParts(Number(x[3]), month, day) : inferYear(month, day, today);
      push(x.index, x[0], date, false);
    },
  );
  scan(
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sept|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b,?(?:\s+(\d{4}))?/g,
    (x) => {
      const month = MONTHS[x[1]];
      const day = Number(x[2]);
      const date = x[3] ? isoFromParts(Number(x[3]), month, day) : inferYear(month, day, today);
      push(x.index, x[0], date, false);
    },
  );
  scan(/(?<![\d.,])(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{4}|\d{2}))?(?![\d.,\/-])/g, (x) => {
    const a = Number(x[1]);
    const b = Number(x[2]);
    let [day, month] = context.monthFirst ? [b, a] : [a, b];
    if (month > 12 && day <= 12) [day, month] = [month, day];
    const year = expandYear(x[3], today);
    const date = year ? isoFromParts(year, month, day) : inferYear(month, day, today);
    push(x.index, x[0], date, false);
  });

  // Drop matches nested inside a longer one (e.g. "yesterday" in "day before yesterday").
  found.sort((p, q) => p.index - q.index || q.text.length - p.text.length);
  const result: DateExpression[] = [];
  let coveredUntil = -1;
  for (const item of found) {
    if (item.index < coveredUntil) continue;
    result.push({ text: item.text, date: item.date, relative: item.relative });
    coveredUntil = item.index + item.text.length;
  }
  return result;
}

export function resolveDatePhrase(text: string, context: DateContext): string | null {
  const iso = normalizeIsoDate(text);
  if (iso) return iso;
  return findDateExpressions(text, context)[0]?.date ?? null;
}

/** Inside [today − maxPastYears, today + futureDays] in the user's timezone. */
export function isPlausibleDate(
  iso: string,
  today: string,
  options?: { futureDays?: number; maxPastYears?: number },
): boolean {
  const ahead = diffDaysIso(iso, today);
  if (ahead > (options?.futureDays ?? 1)) return false;
  const years = options?.maxPastYears ?? 10;
  return ahead >= -Math.round(years * 365.25);
}
