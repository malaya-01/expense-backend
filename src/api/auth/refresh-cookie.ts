import type { CookieOptions, Request } from 'express';

export const REFRESH_COOKIE_NAME = 'refreshToken';

const REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Whether the refresh cookie must work on cross-site requests.
 *
 * In production the frontend and API are served from different sites
 * (e.g. *.vercel.app and *.onrender.com), so the cookie must be
 * `SameSite=None; Secure`. Set COOKIE_CROSS_SITE=true to force that outside
 * production (e.g. a staging API over https used by a deployed frontend).
 */
function isCrossSiteCookie(): boolean {
  const flag = (process.env.COOKIE_CROSS_SITE || '').trim().toLowerCase();
  if (flag === 'true' || flag === '1' || flag === 'yes') return true;
  return process.env.NODE_ENV === 'production';
}

/**
 * Cookie options for the refresh token.
 *
 * Cross-site (production / COOKIE_CROSS_SITE): `SameSite=None; Secure`.
 * Local development over http falls back to `SameSite=Lax` because browsers
 * reject `SameSite=None` without `Secure`.
 */
export function refreshCookieOptions(): CookieOptions {
  const crossSite = isCrossSiteCookie();
  return {
    httpOnly: true,
    secure: crossSite,
    sameSite: crossSite ? 'none' : 'lax',
    maxAge: REFRESH_MAX_AGE_MS,
    path: '/',
  };
}

/** Options for clearing the refresh cookie (must match path/samesite/secure). */
export function clearRefreshCookieOptions(): CookieOptions {
  // Express derives `expires` from maxAge, which would keep the cookie alive.
  const { maxAge: _maxAge, ...options } = refreshCookieOptions();
  return options;
}

/**
 * The refresh token presented by the client. The explicit body value wins over
 * the cookie: native/Capacitor clients persist the latest rotated token
 * themselves, while a WebView cookie can be stale.
 */
export function readPresentedRefreshToken(req: Request): string {
  const fromBody =
    typeof req.body?.refreshToken === 'string'
      ? req.body.refreshToken.trim()
      : '';
  if (fromBody) return fromBody;
  const fromCookie = req.cookies?.[REFRESH_COOKIE_NAME];
  return typeof fromCookie === 'string' ? fromCookie.trim() : '';
}
