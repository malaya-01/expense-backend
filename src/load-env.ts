import { existsSync } from 'fs';
import { resolve } from 'path';

function resolveEnvPath(fileName: string) {
  const candidates = [
    resolve(process.cwd(), fileName),
    resolve(process.cwd(), 'expense-backend', fileName),
  ];
  return candidates.find(existsSync);
}

/**
 * Loads `.env`, then optionally overrides with `.env.supabase`
 * when USE_SUPABASE=true.
 */
export function loadProjectEnv() {
  const basePath = resolveEnvPath('.env');
  require('dotenv').config(basePath ? { path: basePath } : undefined);

  const useSupabase =
    String(process.env.USE_SUPABASE || '')
      .trim()
      .toLowerCase() === 'true';

  if (!useSupabase) return { useSupabase: false, envPath: basePath || null };

  const supabasePath = resolveEnvPath('.env.supabase');
  if (!supabasePath) {
    console.warn(
      'USE_SUPABASE=true but .env.supabase was not found. Keeping base .env.',
    );
    return { useSupabase: false, envPath: basePath || null };
  }

  require('dotenv').config({ path: supabasePath, override: true });
  return { useSupabase: true, envPath: supabasePath };
}

loadProjectEnv();
