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
        const pool = new Pool({
          host: appConfiguration().DB.HOST,
          port: Number(appConfiguration().DB.PORT),
          user: appConfiguration().DB.USERNAME,
          password: appConfiguration().DB.PASSWORD,
          database: appConfiguration().DB.DATABASE,
        });

        await pool.query('SELECT 1');
        console.log('✅ PostgreSQL Connected');

        return pool;
      },
    },
  ],
  exports: ['PG_POOL'],
})
export class DatabaseModule {}
