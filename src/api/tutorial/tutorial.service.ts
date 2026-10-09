import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import {
  TUTORIAL_KEY,
  TUTORIAL_STEPS,
  TUTORIAL_VERSION,
} from './tutorial.catalog';
import type { TutorialProgressDto } from './dto/tutorial.dto';

export type TutorialStatus = 'not_started' | 'in_progress' | 'completed';

export type TutorialProgress = {
  status: TutorialStatus;
  current_step: string | null;
  viewed_steps: string[];
  tutorial_version: number;
  started_at: string | null;
  completed_at: string | null;
  completed_platform: string | null;
  last_seen_at: string | null;
  dismiss_count: number;
  restart_count: number;
};

export type TutorialFacts = {
  accounts: number;
  transactions: number;
  budgets: number;
};

const PROGRESS_COLUMNS = `status, current_step, viewed_steps, tutorial_version,
  started_at, completed_at, completed_platform, last_seen_at,
  dismiss_count, restart_count`;

const STEP_IDS = new Set(TUTORIAL_STEPS.map((step) => step.id));

@Injectable()
export class TutorialService {
  constructor(@Inject('PG_POOL') private readonly pgPool: Pool) {}

  /** Tutorial content plus this user's progress and data facts. */
  async getTutorial(userId: string) {
    const [progress, facts] = await Promise.all([
      this.getProgress(userId),
      this.getFacts(userId),
    ]);
    return {
      key: TUTORIAL_KEY,
      version: TUTORIAL_VERSION,
      steps: TUTORIAL_STEPS,
      progress,
      facts,
      // Clients auto-open the tour on sign-in until it is completed.
      should_show: progress.status !== 'completed',
    };
  }

  /**
   * What the user has already set up, so hands-on steps (create an account,
   * a transaction, a budget) show as done for existing users.
   */
  async getFacts(userId: string): Promise<TutorialFacts> {
    const result = await this.pgPool.query(
      `SELECT
         (SELECT COUNT(*) FROM financial_containers
           WHERE user_id = $1 AND deleted_at IS NULL AND space_id IS NULL
         ) AS accounts,
         (SELECT COUNT(*) FROM ledger_transactions
           WHERE user_id = $1 AND deleted_at IS NULL
         ) AS transactions,
         (SELECT COUNT(*) FROM budgets
           WHERE user_id = $1 AND deleted_at IS NULL
         ) AS budgets`,
      [userId],
    );
    const row = result.rows[0] ?? {};
    return {
      accounts: Number(row.accounts) || 0,
      transactions: Number(row.transactions) || 0,
      budgets: Number(row.budgets) || 0,
    };
  }

  async getProgress(userId: string): Promise<TutorialProgress> {
    const result = await this.pgPool.query(
      `SELECT ${PROGRESS_COLUMNS}
       FROM user_tutorial_progress
       WHERE user_id = $1 AND tutorial_key = $2`,
      [userId, TUTORIAL_KEY],
    );
    // No row: an account created before the tutorial existed, or one that
    // has never opened it. Both start from scratch.
    return result.rowCount ? toProgress(result.rows[0]) : emptyProgress();
  }

  async recordProgress(userId: string, dto: TutorialProgressDto) {
    const stepId = dto.step_id ?? null;
    if (stepId && !STEP_IDS.has(stepId)) {
      throw new BadRequestException('Unknown tutorial step');
    }
    const platform = dto.platform ?? null;

    let sql: string;
    switch (dto.event) {
      case 'view':
        // A replay of a completed tutorial keeps it completed.
        sql = `INSERT INTO user_tutorial_progress AS p
                 (user_id, tutorial_key, status, current_step, viewed_steps,
                  tutorial_version, started_at, last_seen_at)
               VALUES ($1, $2, 'in_progress', $3,
                       CASE WHEN $3::text IS NULL THEN '[]'::jsonb
                            ELSE jsonb_build_array($3::text) END,
                       $4, NOW(), NOW())
               ON CONFLICT (user_id, tutorial_key) DO UPDATE SET
                 status = CASE WHEN p.status = 'completed' THEN 'completed'
                               ELSE 'in_progress' END,
                 current_step = COALESCE($3, p.current_step),
                 viewed_steps = CASE
                   WHEN $3::text IS NULL OR p.viewed_steps ? $3::text
                     THEN p.viewed_steps
                   ELSE p.viewed_steps || jsonb_build_array($3::text) END,
                 tutorial_version = $4,
                 started_at = COALESCE(p.started_at, NOW()),
                 last_seen_at = NOW(),
                 updated_at = NOW()
               RETURNING ${PROGRESS_COLUMNS}`;
        break;
      case 'dismiss':
        // "Skip for now": progress is kept and the tour reopens next sign-in.
        sql = `INSERT INTO user_tutorial_progress AS p
                 (user_id, tutorial_key, status, current_step,
                  tutorial_version, started_at, last_seen_at, dismiss_count)
               VALUES ($1, $2, 'in_progress', $3, $4, NOW(), NOW(), 1)
               ON CONFLICT (user_id, tutorial_key) DO UPDATE SET
                 current_step = COALESCE($3, p.current_step),
                 dismiss_count = p.dismiss_count + 1,
                 last_seen_at = NOW(),
                 updated_at = NOW()
               RETURNING ${PROGRESS_COLUMNS}`;
        break;
      case 'complete':
        sql = `INSERT INTO user_tutorial_progress AS p
                 (user_id, tutorial_key, status, current_step,
                  tutorial_version, started_at, completed_at,
                  completed_platform, last_seen_at)
               VALUES ($1, $2, 'completed', $3, $4, NOW(), NOW(), $5, NOW())
               ON CONFLICT (user_id, tutorial_key) DO UPDATE SET
                 status = 'completed',
                 current_step = COALESCE($3, p.current_step),
                 tutorial_version = $4,
                 started_at = COALESCE(p.started_at, NOW()),
                 completed_at = NOW(),
                 completed_platform = COALESCE($5, p.completed_platform),
                 last_seen_at = NOW(),
                 updated_at = NOW()
               RETURNING ${PROGRESS_COLUMNS}`;
        break;
      default:
        throw new BadRequestException('Unknown tutorial event');
    }

    const params: unknown[] = [userId, TUTORIAL_KEY, stepId, TUTORIAL_VERSION];
    if (dto.event === 'complete') params.push(platform);
    const result = await this.pgPool.query(sql, params);
    return toProgress(result.rows[0]);
  }

  /**
   * Replay from the first step (Settings → Help & tutorial). A completed
   * tutorial stays completed, so abandoning a replay does not bring the
   * tour back on every sign-in.
   */
  async restart(userId: string) {
    const result = await this.pgPool.query(
      `INSERT INTO user_tutorial_progress AS p
         (user_id, tutorial_key, status, tutorial_version, started_at,
          last_seen_at, restart_count)
       VALUES ($1, $2, 'in_progress', $3, NOW(), NOW(), 1)
       ON CONFLICT (user_id, tutorial_key) DO UPDATE SET
         status = CASE WHEN p.status = 'completed' THEN 'completed'
                       ELSE 'in_progress' END,
         current_step = NULL,
         viewed_steps = '[]'::jsonb,
         tutorial_version = $3,
         restart_count = p.restart_count + 1,
         last_seen_at = NOW(),
         updated_at = NOW()
       RETURNING ${PROGRESS_COLUMNS}`,
      [userId, TUTORIAL_KEY, TUTORIAL_VERSION],
    );
    return toProgress(result.rows[0]);
  }
}

function emptyProgress(): TutorialProgress {
  return {
    status: 'not_started',
    current_step: null,
    viewed_steps: [],
    tutorial_version: TUTORIAL_VERSION,
    started_at: null,
    completed_at: null,
    completed_platform: null,
    last_seen_at: null,
    dismiss_count: 0,
    restart_count: 0,
  };
}

function toProgress(row: Record<string, any>): TutorialProgress {
  return {
    status: row.status as TutorialStatus,
    current_step: (row.current_step as string | null) ?? null,
    viewed_steps: Array.isArray(row.viewed_steps)
      ? row.viewed_steps.map(String)
      : [],
    tutorial_version: Number(row.tutorial_version) || TUTORIAL_VERSION,
    started_at: row.started_at ?? null,
    completed_at: row.completed_at ?? null,
    completed_platform: (row.completed_platform as string | null) ?? null,
    last_seen_at: row.last_seen_at ?? null,
    dismiss_count: Number(row.dismiss_count) || 0,
    restart_count: Number(row.restart_count) || 0,
  };
}
