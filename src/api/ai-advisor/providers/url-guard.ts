import { BadRequestException } from '@nestjs/common';
import appConfiguration from 'src/app.configuration';

const BLOCKED_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.google.com',
  '169.254.169.254',
]);

function isPrivateIp(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return true;
  }
  const m = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
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
