import type { Cache } from 'cache-manager';
import type { Pool, PoolClient } from 'pg';

/**
 * One signed-in device per account. A new login revokes every other session
 * with revoked_reason = 'replaced'; requests and refreshes from such a session
 * fail with this code so the client can explain why it was signed out.
 */
export const SESSION_REPLACED = 'SESSION_REPLACED';
export const SESSION_REPLACED_MESSAGE = `${SESSION_REPLACED}: You signed in on another device, so this device was signed out.`;

export type SessionState = 'active' | 'replaced' | 'ended';

/** Short TTL: the DB stays the source of truth if the cache is lost. */
const STATE_TTL_MS = 5 * 60 * 1000;

const key = (sessionId: string) => `session-state:${sessionId}`;

export async function rememberSessionState(
  cache: Cache,
  sessionId: string,
  state: SessionState,
) {
  try {
    await cache.set(key(sessionId), state, STATE_TTL_MS);
  } catch {
    /* best effort; readSessionState falls back to the DB */
  }
}

/** State of the session behind an access token (cached, DB fallback). */
export async function readSessionState(
  cache: Cache,
  pool: Pick<Pool, 'query'> | PoolClient,
  sessionId: string,
): Promise<SessionState> {
  try {
    const cached = await cache.get<SessionState>(key(sessionId));
    if (cached) return cached;
  } catch {
    /* fall through to the DB */
  }
  const result = await pool.query(
    `SELECT revoked_at, revoked_reason, expires_at
     FROM user_sessions WHERE id = $1`,
    [sessionId],
  );
  const row = result.rows[0];
  const state: SessionState = !row
    ? 'ended'
    : row.revoked_at
      ? row.revoked_reason === 'replaced'
        ? 'replaced'
        : 'ended'
      : new Date(row.expires_at) <= new Date()
        ? 'ended'
        : 'active';
  await rememberSessionState(cache, sessionId, state);
  return state;
}
