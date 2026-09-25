-- Up Migration
CREATE TABLE IF NOT EXISTS user_report_schedules (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  frequency TEXT NOT NULL DEFAULT 'weekly'
    CHECK (frequency IN ('weekly', 'monthly', 'custom')),
  weekday SMALLINT NOT NULL DEFAULT 6
    CHECK (weekday BETWEEN 0 AND 6),
  monthly_mode TEXT NOT NULL DEFAULT 'last_day'
    CHECK (monthly_mode IN ('last_day', 'day_of_month')),
  day_of_month SMALLINT NOT NULL DEFAULT 1
    CHECK (day_of_month BETWEEN 1 AND 28),
  custom_mode TEXT NOT NULL DEFAULT 'interval'
    CHECK (custom_mode IN ('interval', 'dates')),
  interval_days INTEGER NOT NULL DEFAULT 14
    CHECK (interval_days BETWEEN 1 AND 365),
  custom_dates DATE[] NOT NULL DEFAULT '{}'::date[],
  send_time TIME NOT NULL DEFAULT '10:00:00',
  include_excel BOOLEAN NOT NULL DEFAULT TRUE,
  include_ai BOOLEAN NOT NULL DEFAULT TRUE,
  last_sent_at TIMESTAMPTZ,
  last_period_key TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_report_schedules_enabled
  ON user_report_schedules (enabled)
  WHERE enabled = TRUE;

-- Down Migration
DROP INDEX IF EXISTS idx_user_report_schedules_enabled;
DROP TABLE IF EXISTS user_report_schedules;
