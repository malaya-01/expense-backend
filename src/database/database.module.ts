import { Module, Global } from '@nestjs/common';
import { Pool, types } from 'pg';
import appConfiguration from 'src/app.configuration';

// DATE OID 1082 — keep calendar dates as YYYY-MM-DD strings.
types.setTypeParser(1082, (value: string) => value);

@Global()
@Module({
  providers: [
    {
      provide: 'PG_POOL',
      useFactory: async () => {
        const db = appConfiguration().DB;
        const pool = new Pool({
          host: db.HOST,
          port: Number(db.PORT),
          user: db.USERNAME,
          password: db.PASSWORD,
          database: db.DATABASE,
          max: 20,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 15_000,
          ...(db.SSL
            ? {
                ssl: {
                  rejectUnauthorized: false,
                },
              }
            : {}),
        });

        await pool.query('SELECT 1');
        console.log(
          `✅ PostgreSQL Connected (${db.HOST}:${db.PORT}/${db.DATABASE}${
            db.SSL ? ', ssl' : ''
          })`,
        );

        return pool;
      },
    },
  ],
  exports: ['PG_POOL'],
})
export class DatabaseModule {}
