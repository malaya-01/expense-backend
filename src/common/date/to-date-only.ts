/**
 * Financial dates are calendar days, never instants.
 * Prefer the YYYY-MM-DD fragment; for node-pg DATE values
 * (UTC midnight Date) use UTC getters so local TZ cannot shift the day.
 */
export function toDateOnly(value: unknown): string | null {
  if (value == null || value === '') return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return [
      value.getUTCFullYear(),
      String(value.getUTCMonth() + 1).padStart(2, '0'),
      String(value.getUTCDate()).padStart(2, '0'),
    ].join('-');
  }

  const match = String(value).match(/(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

export function requireDateOnly(value: unknown, fallback = ''): string {
  return toDateOnly(value) ?? fallback;
}
