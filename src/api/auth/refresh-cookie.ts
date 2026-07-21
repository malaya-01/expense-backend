import type { CookieOptions } from 'express';

export const REFRESH_COOKIE_NAME = 'refreshToken';

const REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Cookie options for the refresh token.
 *
 * In production the frontend and API are served from different sites
 * (e.g. *.vercel.app and *.onrender.com), so the cookie must be
 * `SameSite=None; Secure` to be sent on cross-site requests. In local
 * development over http we fall back to `SameSite=Lax` because browsers
 * reject `SameSite=None` without `Secure`.
 */
export function refreshCookieOptions(): CookieOptions {
  const isProduction = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: REFRESH_MAX_AGE_MS,
    path: '/',
  };
}
