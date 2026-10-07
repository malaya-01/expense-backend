/**
 * Single source of truth for Cloudflare R2 object keys.
 *
 * Every write to the bucket goes through buildObjectKey(). Layout:
 *
 *   users/{userId}/avatar/{shortid}.{ext}
 *   users/{userId}/receipts/{YYYY}/{MM}/{yyyymmdd}-{merchant|receipt}-{shortid}.{ext}
 *   users/{userId}/documents/{YYYY}/{MM}/{slug|document}-{shortid}.{ext}
 *   users/{userId}/exports/{YYYY}/{MM}/{slug|export}-{yyyymmdd}-{shortid}.{ext}
 *   spaces/{spaceId}/receipts/{YYYY}/{MM}/...   (space-owned files)
 *   spaces/{spaceId}/documents/{YYYY}/{MM}/...
 *
 * Client-supplied filenames never reach the key. Every segment is lowercase
 * [a-z0-9-] and length-capped. The date is the bill / transaction date when
 * known, otherwise "now" in the user's timezone.
 *
 * This module is dependency-free (node `crypto` only) so the standalone
 * scripts/migrate-r2-layout.js can load it as well.
 */
import { createHash, randomBytes } from 'crypto';

export type StorageKind = 'avatar' | 'receipt' | 'document' | 'export';

export const STORAGE_KINDS: readonly StorageKind[] = [
  'avatar',
  'receipt',
  'document',
  'export',
];

export type KindPolicy = {
  /** Maximum object size in bytes. */
  maxBytes: number;
  /** Allowed (normalised) MIME types. */
  mimeTypes: ReadonlySet<string>;
};

const MB = 1024 * 1024;

const RASTER_IMAGES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const CAMERA_IMAGES = ['image/heic', 'image/heif'];

/**
 * Limits mirror the existing request validation:
 *  - avatar: multer 5 MB, assertAvatarFile() JPEG/PNG/WebP/GIF (browser-renderable)
 *  - receipt: ParseReceiptDto (png/jpeg/webp/gif/heic/heif/pdf), 8 MB cap in persistReceipt
 *  - document: UploadAiDocumentDto (images/pdf/text/csv/json), 5 MB in uploadDocument
 *  - export: server-generated report files
 */
export const KIND_POLICIES: Record<StorageKind, KindPolicy> = {
  avatar: { maxBytes: 5 * MB, mimeTypes: new Set(RASTER_IMAGES) },
  receipt: {
    maxBytes: 8 * MB,
    mimeTypes: new Set([...RASTER_IMAGES, ...CAMERA_IMAGES, 'application/pdf']),
  },
  document: {
    maxBytes: 5 * MB,
    mimeTypes: new Set([
      ...RASTER_IMAGES,
      ...CAMERA_IMAGES,
      'application/pdf',
      'text/plain',
      'text/csv',
      'application/json',
    ]),
  },
  export: {
    maxBytes: 25 * MB,
    mimeTypes: new Set([
      'application/pdf',
      'text/csv',
      'application/json',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ]),
  },
};

const KIND_FOLDER: Record<StorageKind, string> = {
  avatar: 'avatar',
  receipt: 'receipts',
  document: 'documents',
  export: 'exports',
};

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Matches keys written by this module (any kind, user- or space-owned). */
export const CURRENT_LAYOUT_RE =
  /^(users|spaces)\/[0-9a-f-]{36}\/(avatar|receipts|documents|exports)\/[a-z0-9/.-]+$/;

const SHORT_ID_RE = /^[a-z0-9]{8,16}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isCurrentLayoutKey(key: string | null | undefined): boolean {
  return typeof key === 'string' && CURRENT_LAYOUT_RE.test(key);
}

/** Lowercase, [a-z0-9-] only, no leading/trailing dashes, capped. */
export function slugSegment(value: unknown, maxLength = 40): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}

export function newShortId(): string {
  return randomBytes(6).toString('hex');
}

export function sha256Hex(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

export function normalizeMime(mime: string | null | undefined): string {
  const value = String(mime || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (value === 'image/jpg' || value === 'image/pjpeg') return 'image/jpeg';
  if (value === 'application/x-pdf') return 'application/pdf';
  return value;
}

export function extensionForMime(mime: string | null | undefined): string {
  return EXTENSIONS[normalizeMime(mime)] || 'bin';
}

/**
 * Detect the real type from magic bytes for the binary formats we accept.
 * Returns null for formats that cannot be sniffed (text/csv/json/xlsx).
 */
export function sniffMime(body: Buffer): string | null {
  if (body.length < 12) return null;
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    body[0] === 0x89 &&
    body.toString('latin1', 1, 4) === 'PNG' &&
    body[4] === 0x0d &&
    body[5] === 0x0a
  ) {
    return 'image/png';
  }
  const head = body.toString('latin1', 0, 12);
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (head.slice(4, 8) === 'ftyp') {
    const brand = head.slice(8, 12);
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'].includes(brand)) {
      return 'image/heic';
    }
    if (['mif1', 'msf1', 'heif'].includes(brand)) return 'image/heif';
  }
  // PDFs may carry a short preamble before the header.
  if (body.toString('latin1', 0, 1024).includes('%PDF-')) {
    return 'application/pdf';
  }
  return null;
}

const SNIFFABLE = new Set([
  ...RASTER_IMAGES,
  ...CAMERA_IMAGES,
  'application/pdf',
]);

/**
 * Validate an upload for a kind. Returns the authoritative MIME type
 * (sniffed when possible) or an error message.
 */
export function checkUpload(
  kind: StorageKind,
  declaredMime: string | null | undefined,
  body: Buffer,
): { ok: true; mimeType: string } | { ok: false; error: string } {
  const policy = KIND_POLICIES[kind];
  if (!policy) return { ok: false, error: `Unknown storage kind: ${kind}` };
  if (!body?.length) return { ok: false, error: 'File is empty' };
  if (body.length > policy.maxBytes) {
    return {
      ok: false,
      error: `File must be ${Math.round(policy.maxBytes / MB)} MB or smaller`,
    };
  }
  const declared = normalizeMime(declaredMime);
  const sniffed = sniffMime(body);
  let mimeType = declared;
  if (sniffed) {
    // Trust the bytes over the client label (screenshots are often mislabelled).
    mimeType = sniffed;
  } else if (SNIFFABLE.has(declared)) {
    return { ok: false, error: 'File content does not match its type' };
  }
  if (!policy.mimeTypes.has(mimeType)) {
    return { ok: false, error: `Unsupported file type for ${kind}: ${mimeType || 'unknown'}` };
  }
  return { ok: true, mimeType };
}

export type CalendarDate = { yyyy: string; mm: string; dd: string };

export function safeTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return timeZone;
  } catch {
    return 'UTC';
  }
}

/**
 * Resolve the calendar date for a key. Date-only strings (YYYY-MM-DD) are
 * used verbatim; timestamps / Date objects are converted to the user's zone.
 */
export function calendarDate(
  input: string | Date | null | undefined,
  timeZone?: string | null,
  now: Date = new Date(),
): CalendarDate {
  if (typeof input === 'string') {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
    if (dateOnly && validParts(dateOnly[1], dateOnly[2], dateOnly[3])) {
      return { yyyy: dateOnly[1], mm: dateOnly[2], dd: dateOnly[3] };
    }
  }
  let instant: Date | null = null;
  if (input instanceof Date) instant = input;
  else if (typeof input === 'string' && input.trim()) instant = new Date(input);
  if (!instant || Number.isNaN(instant.getTime())) instant = now;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTimeZone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const pick = (type: string) => parts.find((p) => p.type === type)?.value || '';
  const yyyy = pick('year');
  const mm = pick('month');
  const dd = pick('day');
  if (validParts(yyyy, mm, dd)) return { yyyy, mm, dd };
  const iso = now.toISOString();
  return { yyyy: iso.slice(0, 4), mm: iso.slice(5, 7), dd: iso.slice(8, 10) };
}

function validParts(yyyy: string, mm: string, dd: string): boolean {
  const year = Number(yyyy);
  const month = Number(mm);
  const day = Number(dd);
  return (
    /^\d{4}$/.test(yyyy) &&
    year >= 1970 &&
    year <= 2200 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= 31
  );
}

export type ObjectKeyInput = {
  kind: StorageKind;
  /** Owning user (always required - it is also the access-control owner). */
  userId: string;
  /** Set only for files owned by a collaborative space. */
  spaceId?: string | null;
  mimeType: string;
  /** Bill / transaction date; defaults to now in timeZone. */
  date?: string | Date | null;
  timeZone?: string | null;
  /** Merchant / title hint. Sanitised; never a raw client filename. */
  label?: string | null;
  /** Reuse an existing short id (relocation keeps the file's identity). */
  shortId?: string | null;
  now?: Date;
};

export function ownerPrefix(input: {
  userId: string;
  spaceId?: string | null;
}): string {
  if (input.spaceId) {
    if (!isUuid(input.spaceId)) throw new Error('Invalid space id for storage key');
    return `spaces/${input.spaceId.toLowerCase()}/`;
  }
  return userPrefix(input.userId);
}

/** users/{userId}/ - everything a user owns lives under this prefix. */
export function userPrefix(userId: string): string {
  if (!isUuid(userId)) throw new Error('Invalid user id for storage key');
  return `users/${userId.toLowerCase()}/`;
}

export function buildObjectKey(input: ObjectKeyInput): string {
  if (!KIND_FOLDER[input.kind]) {
    throw new Error(`Unknown storage kind: ${input.kind}`);
  }
  if (!isUuid(input.userId)) throw new Error('Invalid user id for storage key');
  if (input.spaceId && input.kind !== 'receipt' && input.kind !== 'document') {
    throw new Error(`Space-owned ${input.kind} files are not supported`);
  }
  const prefix = ownerPrefix(input);
  const ext = extensionForMime(input.mimeType);
  const id =
    input.shortId && SHORT_ID_RE.test(input.shortId) ? input.shortId : newShortId();
  if (input.kind === 'avatar') {
    return `${prefix}avatar/${id}.${ext}`;
  }
  const { yyyy, mm, dd } = calendarDate(input.date, input.timeZone, input.now);
  const folder = `${prefix}${KIND_FOLDER[input.kind]}/${yyyy}/${mm}/`;
  const ymd = `${yyyy}${mm}${dd}`;
  switch (input.kind) {
    case 'receipt':
      return `${folder}${ymd}-${slugSegment(input.label) || 'receipt'}-${id}.${ext}`;
    case 'document':
      return `${folder}${slugSegment(input.label, 60) || 'document'}-${id}.${ext}`;
    case 'export':
      return `${folder}${slugSegment(input.label) || 'export'}-${ymd}-${id}.${ext}`;
  }
  throw new Error(`Unknown storage kind: ${String(input.kind)}`);
}

/** Short id of a key written by buildObjectKey(), else null. */
export function shortIdFromKey(key: string | null | undefined): string | null {
  if (!isCurrentLayoutKey(key)) return null;
  const file = String(key).split('/').pop() || '';
  const stem = file.replace(/\.[a-z0-9]+$/, '');
  const id = stem.split('-').pop() || '';
  return SHORT_ID_RE.test(id) ? id : null;
}

/** True when `key` is inside the user's own prefix. */
export function keyBelongsToUser(key: string, userId: string): boolean {
  return isUuid(userId) && key.startsWith(userPrefix(userId));
}

/** Clean an original filename for DB / Content-Disposition (never for keys). */
export function cleanOriginalName(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  const base = name.split(/[\\/]/).pop() || '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim().slice(0, 180);
  return cleaned || null;
}

/** RFC 6266 / 5987 Content-Disposition with an ASCII fallback. */
export function contentDisposition(
  type: 'inline' | 'attachment',
  filename: string | null | undefined,
  mimeType?: string | null,
): string {
  const name =
    cleanOriginalName(filename) || `file.${extensionForMime(mimeType)}`;
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/[\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** S3 user metadata must be ASCII header-safe. */
export function metadataValue(value: string | null | undefined, max = 512): string {
  return encodeURIComponent(String(value || '')).slice(0, max);
}
