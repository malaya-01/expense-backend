import { BadRequestException } from '@nestjs/common';
import appConfiguration from 'src/app.configuration';

const BLOCKED_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.google.com',
  '169.254.169.254',
]);

function isPrivateIp(rawHostname: string): boolean {
  // WHATWG URL keeps IPv6 hosts in brackets ("[::1]").
  let hostname = rawHostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname.includes(':')) {
    if (hostname === '::1' || hostname === '::') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(hostname)) return true; // fc00::/7 ULA
    if (/^fe[89ab][0-9a-f]:/.test(hostname)) return true; // fe80::/10
    const mapped = hostname.match(/^::ffff:(.+)$/);
    if (!mapped) return false;
    hostname = mapped[1];
    const hex = hostname.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      hostname = [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
    }
  }
  const m = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** Validate local / OpenAI-compatible base URLs to reduce SSRF risk. */
export function validateModelBaseUrl(raw?: string | null): string | null {
  if (!raw || !String(raw).trim()) return null;
  let url: URL;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new BadRequestException('Base URL is invalid.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new BadRequestException('Base URL must use http or https.');
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new BadRequestException(
      'Base URL must not include credentials, a query string or a fragment.',
    );
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) {
    throw new BadRequestException('This host is not allowed for local models.');
  }
  const allowPrivate = appConfiguration().AI.ALLOW_PRIVATE_MODEL_HOSTS;
  if (!allowPrivate && isPrivateIp(host)) {
    throw new BadRequestException(
      'Private/local model hosts are disabled by server policy.',
    );
  }
  // Prefer private/local endpoints for "local" provider; still allow public OpenAI-compatible hosts.
  return url.toString().replace(/\/$/, '');
}

export function normalizeOpenAiCompatibleUrl(baseUrl?: string | null): string {
  const fallback = 'http://127.0.0.1:11434/v1';
  const validated = validateModelBaseUrl(baseUrl) || fallback;
  if (validated.endsWith('/v1')) return validated;
  if (validated.includes('/v1/')) return validated.replace(/\/$/, '');
  return `${validated.replace(/\/$/, '')}/v1`;
}
