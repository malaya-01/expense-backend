import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { Pool, types } from 'pg';
import appConfiguration from 'src/app.configuration';

// DATE OID 1082 — keep calendar dates as YYYY-MM-DD strings.
types.setTypeParser(1082, (value: string) => value);

function resolvePoolMax(db: {
  SSL?: boolean;
  HOST?: string | number | null;
}): number {
  const fromEnv = Number(process.env.PG_POOL_MAX || '');
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.min(Math.floor(fromEnv), 20);
  }
  const host = String(db.HOST || '').toLowerCase();
  const sharedHost =
    Boolean(db.SSL) ||
    host.includes('supabase') ||
    host.includes('neon.tech') ||
    host.includes('pooler');
  // Session-mode poolers (Supabase/Neon) often cap around 15 total clients
  // across the whole project — keep our Nest pool well under that.
  return sharedHost ? 5 : 10;
}

async function createPgPool(): Promise<Pool> {
  const db = appConfiguration().DB;
  const max = resolvePoolMax(db);
  const pool = new Pool({
    host: db.HOST as string,
    port: Number(db.PORT),
    user: db.USERNAME as string,
    password: db.PASSWORD as string,
    database: db.DATABASE as string,
    max,
    min: 0,
    idleTimeoutMillis: Number(process.env.PG_POOL_IDLE_MS || 10_000),
    connectionTimeoutMillis: Number(process.env.PG_POOL_CONNECT_MS || 15_000),
    allowExitOnIdle: true,
    application_name: 'opal-expense-backend',
    ...(db.SSL
      ? {
          ssl: {
            rejectUnauthorized: false,
          },
        }
      : {}),
  });

  pool.on('error', (err) => {
    console.error('[PG_POOL] idle client error:', err.message);
  });

  await pool.query('SELECT 1');
  console.log(
    `✅ PostgreSQL Connected (${db.HOST}:${db.PORT}/${db.DATABASE}${
      db.SSL ? ', ssl' : ''
    }, pool max=${max})`,
  );
  return pool;
}

@Global()
@Module({
  providers: [
    {
      provide: 'PG_POOL',
      useFactory: createPgPool,
    },
  ],
  exports: ['PG_POOL'],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject('PG_POOL') private readonly pool: Pool) {}

  async onApplicationShutdown() {
    try {
      await this.pool.end();
    } catch (err: any) {
      console.warn('[PG_POOL] shutdown:', err?.message || err);
    }
  }
}
