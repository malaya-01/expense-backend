-- Up Migration
-- Per-user progress through the in-app guided tutorial. One row per
-- (user, tutorial). Users without a row have never seen the tutorial, so
-- existing accounts are treated as "not started" and get the tour too.
CREATE TABLE IF NOT EXISTS user_tutorial_progress (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tutorial_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'in_progress', 'completed')),
  current_step TEXT,
  viewed_steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  tutorial_version INT NOT NULL DEFAULT 1,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  completed_platform TEXT,
  last_seen_at TIMESTAMPTZ,
  dismiss_count INT NOT NULL DEFAULT 0,
  restart_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, tutorial_key)
);

-- Down Migration
DROP TABLE IF EXISTS user_tutorial_progress;
