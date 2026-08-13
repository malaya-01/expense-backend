import './load-env';

export default () => ({
  PROJECT: 'Opal',
  PORT: parseInt(process.env.PORT || '9000'),

  ENVIRONMENT: process.env.NODE_ENV || 'development',
  CLIENT_HOST: process.env.CLIENT_HOST || 'http://localhost:3000',
  JWT: {
    SECRET:
      process.env.JWT_ACCESS_SECRET ||
      process.env.JWT_SECRET ||
      'kjhdiuwidh76uuh5egd8hd2nd93dg5hyqyshuyq',
    REFRESH_SECRET:
      process.env.JWT_REFRESH_SECRET ||
      process.env.JWT_SECRET ||
      'kjhdiuwidh76uuh5egd8hd2nd93dg5hyqyshuyq',
    EXP: process.env.JWT_EXPIRES_IN || '2d',
  },
  CACHE: {
    REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
    REDIS_TTL: parseInt(process.env.REDIS_TTL || '43200'),
  },
  API: {
    GLOBAL_PREFIX: process.env.API_GLOBAL_PREFIX || `/api`,
  },
  DB: {
    TYPE: process.env.PG_TYPE,
    PORT: process.env.PG_PORT,
    HOST: process.env.PG_HOST,
    USERNAME: process.env.PG_USERNAME,
    PASSWORD: process.env.PG_PASSWORD,
    DATABASE: process.env.PG_DATABASE,
    URL: process.env.DB_URL,
    SSL:
      String(process.env.PG_SSL || '')
        .trim()
        .toLowerCase() === 'true' ||
      String(process.env.USE_SUPABASE || '')
        .trim()
        .toLowerCase() === 'true',
  },
  AI: {
    CREDENTIALS_ENCRYPTION_KEY: process.env.AI_CREDENTIALS_ENCRYPTION_KEY || '',
    ALLOW_PRIVATE_MODEL_HOSTS:
      (process.env.AI_ALLOW_PRIVATE_MODEL_HOSTS || 'true').toLowerCase() !==
      'false',
    OMNIROUTE_BASE_URL: process.env.OMNIROUTE_BASE_URL || '',
    OMNIROUTE_API_KEY: process.env.OMNIROUTE_API_KEY || '',
    /** Optional shared OpenRouter key for free :free models (users never see it). */
    OMNIROUTE_PLATFORM_KEY:
      process.env.OMNIROUTE_PLATFORM_KEY ||
      process.env.OPENROUTER_API_KEY ||
      '',
    OMNIROUTE_DAILY_LIMIT: parseInt(process.env.OMNIROUTE_DAILY_LIMIT || '20', 10),
  },
  SWAGGER: {
    TITLE: 'Opal APIs',
    DESCRIPTION: 'Personal Financial Operating System',
    VERSION: '1.0.0',
  },
  ADMIN_EMAILS: process.env.ADMIN_EMAILS || '',
});
