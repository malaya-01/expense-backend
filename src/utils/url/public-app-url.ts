/**
 * Public web origin used in emails (verification / recovery links).
 * CLIENT_HOST may be a comma-separated CORS list — never use that string whole.
 */
export function resolvePublicAppOrigin(): string {
  const explicit = [
    process.env.FRONTEND_URL,
    process.env.PUBLIC_APP_URL,
    process.env.WEB_APP_URL,
    process.env.NEXT_PUBLIC_WEB_PORTAL_URL,
  ]
    .map((v) => String(v || '').trim().replace(/^["']|["']$/g, ''))
    .find(Boolean);

  if (explicit) {
    return explicit.replace(/\/$/, '');
  }

  const hosts = String(process.env.CLIENT_HOST || '')
    .split(',')
    .map((v) => v.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
    .map((v) => v.replace(/\/$/, ''));

  const isLocal = (url: string) =>
    /localhost|127\.0\.0\.1|10\.0\.2\.2|capacitor:|ionic:/i.test(url);

  const publicHttps = hosts.find(
    (h) => /^https:\/\//i.test(h) && !isLocal(h),
  );
  if (publicHttps) return publicHttps;

  const publicHttp = hosts.find(
    (h) => /^http:\/\//i.test(h) && !isLocal(h),
  );
  if (publicHttp) return publicHttp;

  const localWeb = hosts.find((h) => /^https?:\/\//i.test(h) && isLocal(h));
  if (localWeb) return localWeb;

  return 'http://localhost:3000';
}

export function buildAppPathUrl(path: string, query?: Record<string, string>) {
  const origin = resolvePublicAppOrigin();
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(cleanPath, `${origin}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value != null && value !== '') url.searchParams.set(key, value);
    }
  }
  return url.toString();
}
