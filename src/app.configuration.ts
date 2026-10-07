import './load-env';

const DEV_FALLBACK_ACCESS_SECRET = 'dev-only-insecure-access-secret-change-me';
const DEV_FALLBACK_REFRESH_SECRET = 'dev-only-insecure-refresh-secret-change-me';
let warnedAboutJwtFallback = false;

/**
 * JWT secrets come from the environment. Production refuses to start without
 * them; other environments fall back to distinct, clearly-marked dev values.
 */
function resolveJwtSecrets() {
  const access =
    process.env.JWT_ACCESS_SECRET?.trim() || process.env.JWT_SECRET?.trim();
  const refresh =
    process.env.JWT_REFRESH_SECRET?.trim() || process.env.JWT_SECRET?.trim();
  if (access && refresh) return { access, refresh };

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'JWT secret is not configured. Set JWT_SECRET (or JWT_ACCESS_SECRET and JWT_REFRESH_SECRET).',
    );
  }
  if (!warnedAboutJwtFallback) {
    warnedAboutJwtFallback = true;
    // eslint-disable-next-line no-console
    console.warn(
      '[Opal] JWT_SECRET / JWT_ACCESS_SECRET / JWT_REFRESH_SECRET not set — using insecure development fallbacks. Never run like this in production.',
    );
  }
  return {
    access: access || DEV_FALLBACK_ACCESS_SECRET,
    refresh: refresh || DEV_FALLBACK_REFRESH_SECRET,
  };
}

export default () => ({
  PROJECT: 'Opal',
  PORT: parseInt(process.env.PORT || '9000'),

  ENVIRONMENT: process.env.NODE_ENV || 'development',
  /** Comma-separated CORS origins (may include Capacitor). */
  CLIENT_HOST: process.env.CLIENT_HOST || 'http://localhost:3000',
  /** Single public web URL for email links (verification, etc.). */
  FRONTEND_URL:
    process.env.FRONTEND_URL ||
    process.env.PUBLIC_APP_URL ||
    process.env.WEB_APP_URL ||
    '',
  JWT: (() => {
    const secrets = resolveJwtSecrets();
    return {
      SECRET: secrets.access,
      REFRESH_SECRET: secrets.refresh,
      EXP: process.env.JWT_EXPIRES_IN || '2d',
    };
  })(),
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
    // Private/loopback model hosts are an SSRF risk on a shared server; only
    // allow them by default outside production (e.g. a local Ollama).
    ALLOW_PRIVATE_MODEL_HOSTS:
      (
        process.env.AI_ALLOW_PRIVATE_MODEL_HOSTS ||
        (process.env.NODE_ENV === 'production' ? 'false' : 'true')
      ).toLowerCase() !== 'false',
    /** Fast free LLM for Opal Free (preferred). */
    GROQ_API_KEY: process.env.GROQ_API_KEY || '',
    GEMINI_API_KEY:
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_AI_API_KEY ||
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
      '',
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
  MAIL: {
    /** `mailtrap` (API) | `smtp` | `auto` (API first, then SMTP). */
    PROVIDER: (process.env.MAIL_PROVIDER || 'auto').trim().toLowerCase(),
    MAILTRAP_API_HOST:
      process.env.MAILTRAP_API_HOST || 'send.api.mailtrap.io',
    MAILTRAP_FROM_EMAIL:
      process.env.MAILTRAP_FROM_EMAIL || 'hello@demomailtrap.co',
    MAILTRAP_FROM_NAME: process.env.MAILTRAP_FROM_NAME || 'Opal',
    MAILTRAP_USE_SANDBOX:
      String(process.env.MAILTRAP_USE_SANDBOX || '')
        .trim()
        .toLowerCase() === 'true',
    MAILTRAP_INBOX_ID: process.env.MAILTRAP_INBOX_ID || '',
    MAILTRAP_CATEGORY: process.env.MAILTRAP_CATEGORY || 'Transactional',
    SMTP_HOST: process.env.SMTP_HOST || 'live.smtp.mailtrap.io',
    SMTP_PORT: parseInt(process.env.SMTP_PORT || '587', 10),
    SMTP_SECURE:
      String(process.env.SMTP_SECURE || '')
        .trim()
        .toLowerCase() === 'true',
    /** Dashboard username is often `apismtp@mailtrap.io`; Mailtrap's Node sample uses `api`. */
    SMTP_USER: process.env.SMTP_USER || 'apismtp@mailtrap.io',
    SMTP_FROM:
      process.env.SMTP_FROM ||
      `Opal <${process.env.MAILTRAP_FROM_EMAIL || 'hello@demomailtrap.co'}>`,
  },
});
