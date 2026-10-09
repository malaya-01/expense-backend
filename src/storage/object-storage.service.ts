import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Pool } from 'pg';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { Readable } from 'stream';
import appConfiguration from 'src/app.configuration';
import {
  StorageKind,
  buildObjectKey,
  checkUpload,
  cleanOriginalName,
  contentDisposition,
  isUuid,
  metadataValue,
  safeTimeZone,
  sha256Hex,
  shortIdFromKey,
  userPrefix,
} from './storage-keys';

export const R2_CONFIG_KEY = 'cloudflare_r2';

export type R2Config = {
  provider: 'cloudflare-r2';
  accountId: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  apiToken: string;
  bucket: string;
  region: 'auto';
};

export type StoredObject = {
  id: string;
  /** Internal R2 key. Never return this to API clients. */
  objectKey: string;
  publicPath: string;
  token: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
};

export type StoredFileRecord = {
  id: string;
  /** Uploader / personal owner. */
  userId: string | null;
  /** Owning collaborative space (space receipts), else null. */
  spaceId: string | null;
  kind: string;
  objectKey: string;
  token: string;
  mimeType: string;
  sizeBytes: number | null;
  originalFilename: string | null;
  sha256: string | null;
};

export type SaveFileInput = {
  /** Uploader; owner of personal files. */
  userId: string;
  /** Set for files owned by a collaborative space (spaces/{spaceId}/...). */
  spaceId?: string | null;
  kind: StorageKind;
  body: Buffer;
  mimeType: string;
  /** Client filename: kept in DB / Content-Disposition only, never in the key. */
  filename?: string | null;
  /** Bill / transaction date (YYYY-MM-DD or timestamp). Defaults to now. */
  date?: string | Date | null;
  /** Merchant / title hint for the key slug (sanitised). */
  label?: string | null;
  /** IANA zone. Defaults to users.timezone, then UTC. */
  timeZone?: string | null;
};

export type RelocateContext = {
  date?: string | Date | null;
  label?: string | null;
  timeZone?: string | null;
};

export type MediaObjectStream = {
  body: Readable;
  contentLength: number | null;
};

export const MEDIA_PATH_PREFIX = '/api/media/';
const TOKEN_RE = /^[a-f0-9]{32,64}$/i;
const DEFAULT_SIGNED_TTL_SECONDS = 15 * 60;
const MAX_SIGNED_TTL_SECONDS = 7 * 24 * 60 * 60;

const FILE_COLUMNS = `id, user_id, space_id, kind, object_key, public_token,
  mime_type, size_bytes, original_filename, sha256`;

@Injectable()
export class ObjectStorageService {
  private readonly logger = new Logger(ObjectStorageService.name);
  private client: S3Client | null = null;
  private clientSignature = '';

  constructor(@Inject('PG_POOL') private readonly pgPool: Pool) {}

  async getConfig(): Promise<R2Config> {
    const existing = await this.pgPool.query(
      `SELECT config FROM app_config WHERE key = $1`,
      [R2_CONFIG_KEY],
    );
    const row = existing.rows[0]?.config as R2Config | undefined;
    if (row?.bucket && row.accessKeyId && row.secretAccessKey && row.endpoint) {
      return row;
    }
    const seeded = configFromEnv();
    if (!seeded.bucket || !seeded.accessKeyId || !seeded.secretAccessKey) {
      throw new ServiceUnavailableException(
        'Cloudflare R2 configuration is missing from the database.',
      );
    }
    await this.pgPool.query(
      `INSERT INTO app_config (key, config)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE
         SET config = EXCLUDED.config, updated_at = NOW()`,
      [R2_CONFIG_KEY, JSON.stringify(seeded)],
    );
    return seeded;
  }

  // ---------------------------------------------------------------- writes

  /**
   * Validate, store and register a user file. The key is always built by
   * storage-keys.buildObjectKey(); throws BadRequestException on a bad type
   * or size.
   */
  async saveFile(input: SaveFileInput): Promise<StoredObject> {
    if (!isUuid(input.userId)) {
      throw new BadRequestException('Invalid file owner');
    }
    if (input.spaceId && !isUuid(input.spaceId)) {
      throw new BadRequestException('Invalid space');
    }
    const checked = checkUpload(input.kind, input.mimeType, input.body);
    if (!checked.ok) throw new BadRequestException(checked.error);
    const mimeType = checked.mimeType;

    const config = await this.getConfig();
    const timeZone =
      input.kind === 'avatar'
        ? 'UTC'
        : safeTimeZone(input.timeZone || (await this.userTimeZone(input.userId)));
    const objectKey = buildObjectKey({
      kind: input.kind,
      userId: input.userId,
      spaceId: input.spaceId || null,
      mimeType,
      date: input.date,
      timeZone,
      label: input.label,
    });
    const token = randomBytes(24).toString('hex');
    const sha256 = sha256Hex(input.body);
    const filename = cleanOriginalName(input.filename);

    await this.putObject(config, objectKey, input.body, {
      contentType: mimeType,
      contentDisposition: contentDisposition('inline', filename, mimeType),
      metadata: {
        'user-id': input.userId,
        ...(input.spaceId ? { 'space-id': input.spaceId } : {}),
        kind: input.kind,
        sha256,
        'original-name': metadataValue(filename),
      },
    });

    try {
      const inserted = await this.pgPool.query(
        `INSERT INTO stored_files
          (user_id, space_id, kind, object_key, public_token, mime_type,
           size_bytes, original_filename, sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          input.userId,
          input.spaceId || null,
          input.kind,
          objectKey,
          token,
          mimeType,
          input.body.length,
          filename,
          sha256,
        ],
      );
      return {
        id: inserted.rows[0].id as string,
        objectKey,
        publicPath: `${MEDIA_PATH_PREFIX}${token}`,
        token,
        mimeType,
        sizeBytes: input.body.length,
        sha256,
      };
    } catch (error) {
      await this.deleteObjectQuietly(config, objectKey);
      throw error;
    }
  }

  /**
   * Move a file to the key its context implies (e.g. a receipt once the
   * transaction date / merchant is known). The public token and file id are
   * unchanged, so stored URLs keep working. Best-effort: never throws.
   */
  async relocateFile(
    fileId: string,
    userId: string,
    context: RelocateContext,
  ): Promise<string | null> {
    try {
      if (!isUuid(fileId) || !isUuid(userId)) return null;
      const file = await this.findById(fileId);
      if (!file || !(await this.canAccess(file, userId))) return null;
      const kind = file.kind as StorageKind;
      if (kind !== 'receipt' && kind !== 'document') return null;
      const timeZone = safeTimeZone(
        context.timeZone || (await this.userTimeZone(userId)),
      );
      const target = buildObjectKey({
        kind,
        userId: file.userId || userId,
        spaceId: file.spaceId,
        mimeType: file.mimeType,
        date: context.date,
        label: context.label,
        timeZone,
        shortId: shortIdFromKey(file.objectKey),
      });
      if (target === file.objectKey) return target;
      await this.moveObject(file, target);
      return target;
    } catch (error) {
      this.logger.warn(
        `Relocating stored file ${fileId} failed: ${errorMessage(error)}`,
      );
      return null;
    }
  }

  /**
   * Copy -> repoint DB -> delete old. Used by relocateFile and mirrors
   * scripts/migrate-r2-layout.js.
   */
  private async moveObject(file: StoredFileRecord, target: string) {
    const config = await this.getConfig();
    const client = await this.clientFor(config);
    await client.send(
      new CopyObjectCommand({
        Bucket: config.bucket,
        Key: target,
        CopySource: copySource(config.bucket, file.objectKey),
        MetadataDirective: 'COPY',
      }),
    );
    const updated = await this.pgPool.query(
      `UPDATE stored_files
       SET object_key = $3,
           legacy_object_key = COALESCE(legacy_object_key,
             CASE WHEN object_key LIKE 'users/%' OR object_key LIKE 'spaces/%'
                  THEN NULL ELSE object_key END),
           updated_at = NOW()
       WHERE id = $1 AND object_key = $2 AND deleted_at IS NULL`,
      [file.id, file.objectKey, target],
    );
    if (!updated.rowCount) {
      // Moved or deleted concurrently: drop our copy, keep theirs.
      await this.deleteObjectQuietly(config, target);
      return;
    }
    await this.pgPool.query(
      `UPDATE receipts
       SET file_path = $3, stored_file_id = $1, updated_at = NOW()
       WHERE user_id = $4 AND (stored_file_id = $1 OR file_path = $2)`,
      [file.id, file.objectKey, target, file.userId],
    );
    await this.deleteObjectQuietly(config, file.objectKey);
  }

  // ----------------------------------------------------------------- reads

  async findByToken(token: string): Promise<StoredFileRecord | null> {
    if (!TOKEN_RE.test(token || '')) return null;
    const found = await this.pgPool.query(
      `SELECT ${FILE_COLUMNS} FROM stored_files
       WHERE public_token = $1 AND deleted_at IS NULL`,
      [token],
    );
    return found.rowCount ? toRecord(found.rows[0]) : null;
  }

  async findById(id: string): Promise<StoredFileRecord | null> {
    if (!isUuid(id)) return null;
    const found = await this.pgPool.query(
      `SELECT ${FILE_COLUMNS} FROM stored_files
       WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return found.rowCount ? toRecord(found.rows[0]) : null;
  }

  /**
   * Authorisation for a stored file: space files are readable by every
   * active member of a live space; personal files only by their owner.
   */
  async canAccess(
    file: StoredFileRecord,
    userId: string | null | undefined,
  ): Promise<boolean> {
    if (!userId || !isUuid(userId)) return false;
    if (file.spaceId) {
      const member = await this.pgPool.query(
        `SELECT 1
         FROM space_members m
         JOIN collaborative_spaces s ON s.id = m.space_id AND s.deleted_at IS NULL
         WHERE m.space_id = $1 AND m.user_id = $2 AND m.status = 'active'
         LIMIT 1`,
        [file.spaceId, userId],
      );
      return Boolean(member.rowCount);
    }
    return Boolean(file.userId && file.userId === userId);
  }

  /** True when R2 credentials are available (DB app_config or R2_* env). */
  async isConfigured(): Promise<boolean> {
    try {
      await this.getConfig();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read a whole stored file into memory after an access check (owner, or
   * space member for space files). Returns null when missing / not allowed.
   */
  async readFileBuffer(
    fileId: string,
    userId: string,
    maxBytes = 32 * 1024 * 1024,
  ): Promise<{ body: Buffer; mimeType: string } | null> {
    const file = await this.findById(fileId);
    if (!file || !(await this.canAccess(file, userId))) return null;
    const object = await this.openObject(file);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of object.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        object.body.destroy();
        throw new Error('Stored file exceeds read limit');
      }
      chunks.push(buf);
    }
    return { body: Buffer.concat(chunks), mimeType: file.mimeType };
  }

  /**
   * Open the object for streaming. Retries once with a fresh row when the
   * object was relocated between the DB read and the GET.
   */
  async openObject(file: StoredFileRecord): Promise<MediaObjectStream> {
    const config = await this.getConfig();
    try {
      return await this.getObjectStream(config, file.objectKey);
    } catch (error) {
      const fresh = await this.findById(file.id);
      if (!fresh || fresh.objectKey === file.objectKey) throw error;
      file.objectKey = fresh.objectKey;
      return this.getObjectStream(config, fresh.objectKey);
    }
  }

  // --------------------------------------------------------- signed URLs

  /** Access policy for non-avatar files served by /api/media/<token>. */
  mediaAccessMode(): 'token' | 'signed' {
    return String(process.env.MEDIA_ACCESS_MODE || '')
      .trim()
      .toLowerCase() === 'signed'
      ? 'signed'
      : 'token';
  }

  signedMediaPath(
    token: string,
    ttlSeconds?: number,
  ): { url: string; expires_at: string } {
    const configured = Number(process.env.MEDIA_SIGNED_URL_TTL_SECONDS);
    const ttl = Math.min(
      Math.max(
        60,
        Math.floor(
          ttlSeconds ||
            (Number.isFinite(configured) && configured > 0
              ? configured
              : DEFAULT_SIGNED_TTL_SECONDS),
        ),
      ),
      MAX_SIGNED_TTL_SECONDS,
    );
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const sig = this.mediaSignature(token, exp);
    return {
      url: `${MEDIA_PATH_PREFIX}${token}?exp=${exp}&sig=${sig}`,
      expires_at: new Date(exp * 1000).toISOString(),
    };
  }

  verifyMediaSignature(token: string, exp: unknown, sig: unknown): boolean {
    const expires = Number(exp);
    if (!Number.isInteger(expires) || typeof sig !== 'string') return false;
    if (expires < Math.floor(Date.now() / 1000)) return false;
    if (expires > Math.floor(Date.now() / 1000) + MAX_SIGNED_TTL_SECONDS) {
      return false;
    }
    const expected = Buffer.from(this.mediaSignature(token, expires));
    const given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private mediaSignature(token: string, exp: number): string {
    return createHmac('sha256', this.mediaSecret())
      .update(`${token}.${exp}`)
      .digest('base64url');
  }

  private mediaSecret(): string {
    const explicit = process.env.MEDIA_URL_SECRET?.trim();
    if (explicit) return explicit;
    // Derived (not reused verbatim) from the access-token secret.
    return createHmac('sha256', appConfiguration().JWT.SECRET)
      .update('opal-media-url-v1')
      .digest('hex');
  }

  // ------------------------------------------------------------ lifecycle

  /**
   * Remove a space-owned file (e.g. a deleted space expense's receipt).
   * Best-effort: never throws.
   */
  async deleteSpaceFile(fileId: string, spaceId: string): Promise<void> {
    try {
      const file = await this.findById(fileId);
      if (!file || file.spaceId !== spaceId) return;
      await this.removeFile(file);
    } catch (error) {
      this.logger.warn(`Deleting space file ${fileId} failed: ${errorMessage(error)}`);
    }
  }

  /**
   * Remove the file behind a /api/media/<token> path. When ownerUserId is
   * given, only that user's personal file is touched. Best-effort: never throws.
   */
  async deletePublicPath(
    publicPath: string | null | undefined,
    ownerUserId?: string,
  ): Promise<void> {
    const token = publicPath ? tokenFromPublicPath(publicPath) : null;
    if (!token) return;
    try {
      const file = await this.findByToken(token);
      if (!file) return;
      if (ownerUserId && (file.userId !== ownerUserId || file.spaceId)) return;
      await this.removeFile(file);
    } catch (error) {
      this.logger.warn(`Deleting media ${token.slice(0, 8)}... failed: ${errorMessage(error)}`);
    }
  }

  /** Best-effort removal by id, scoped to the owner. Never throws. */
  async deleteFileById(fileId: string, ownerUserId: string): Promise<void> {
    try {
      const file = await this.findById(fileId);
      if (!file || file.userId !== ownerUserId || file.spaceId) return;
      await this.removeFile(file);
    } catch (error) {
      this.logger.warn(`Deleting stored file ${fileId} failed: ${errorMessage(error)}`);
    }
  }

  /**
   * Mark the row deleted first (the token stops resolving at once), then
   * delete the object. A failed object delete leaves the row marked as an
   * orphan for retryOrphanedDeletes().
   */
  private async removeFile(file: StoredFileRecord): Promise<void> {
    await this.pgPool.query(
      `UPDATE stored_files SET deleted_at = COALESCE(deleted_at, NOW()), updated_at = NOW()
       WHERE id = $1`,
      [file.id],
    );
    try {
      const config = await this.getConfig();
      await this.deleteObject(config, file.objectKey);
      await this.pgPool.query(`DELETE FROM stored_files WHERE id = $1`, [file.id]);
    } catch (error) {
      this.logger.warn(
        `Object for stored file ${file.id} left as orphan: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Daily: retry object deletion for rows marked deleted, and remove files
   * left with neither an owning user nor a space.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async retryOrphanedDeletes(limit = 200): Promise<number> {
    let removed = 0;
    try {
      const rows = await this.pgPool.query(
        `SELECT id, object_key FROM stored_files
         WHERE deleted_at IS NOT NULL
            OR (user_id IS NULL AND space_id IS NULL)
         ORDER BY deleted_at NULLS LAST
         LIMIT $1`,
        [limit],
      );
      if (!rows.rowCount) return 0;
      const config = await this.getConfig();
      for (const row of rows.rows) {
        try {
          await this.deleteObject(config, row.object_key as string);
          await this.pgPool.query(`DELETE FROM stored_files WHERE id = $1`, [row.id]);
          removed += 1;
        } catch (error) {
          this.logger.warn(`Orphan ${row.id} still not deleted: ${errorMessage(error)}`);
        }
      }
    } catch (error) {
      this.logger.warn(`Orphan cleanup skipped: ${errorMessage(error)}`);
    }
    return removed;
  }

  /**
   * Account deletion: purge every object under users/{userId}/ plus any
   * legacy-key objects still registered to the user, then drop the rows.
   * Space-owned files the user uploaded stay with the space (their user_id
   * becomes NULL if the users row is hard-deleted).
   */
  async purgeUserFiles(userId: string): Promise<{ objects: number; rows: number }> {
    const prefix = userPrefix(userId);
    const config = await this.getConfig();
    const client = await this.clientFor(config);
    const keys = new Set<string>();
    let continuationToken: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const item of page.Contents || []) {
        if (item.Key) keys.add(item.Key);
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);

    const rows = await this.pgPool.query(
      `SELECT object_key, legacy_object_key FROM stored_files
       WHERE user_id = $1 AND space_id IS NULL`,
      [userId],
    );
    for (const row of rows.rows) {
      if (row.object_key) keys.add(row.object_key as string);
      if (row.legacy_object_key) keys.add(row.legacy_object_key as string);
    }

    const all = [...keys];
    let deleted = 0;
    for (let i = 0; i < all.length; i += 1000) {
      const batch = all.slice(i, i + 1000);
      const result = await client.send(
        new DeleteObjectsCommand({
          Bucket: config.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      deleted += batch.length - (result.Errors?.length || 0);
      for (const failure of result.Errors || []) {
        this.logger.warn(`Purge of ${failure.Key} failed: ${failure.Message}`);
      }
    }
    const removedRows = await this.pgPool.query(
      `DELETE FROM stored_files WHERE user_id = $1 AND space_id IS NULL`,
      [userId],
    );
    return { objects: deleted, rows: removedRows.rowCount || 0 };
  }

  // --------------------------------------------------------------- helpers

  private async userTimeZone(userId: string): Promise<string | null> {
    try {
      const found = await this.pgPool.query(
        `SELECT timezone FROM users WHERE id = $1`,
        [userId],
      );
      return (found.rows[0]?.timezone as string | undefined) || null;
    } catch {
      return null;
    }
  }

  private async clientFor(config: R2Config): Promise<S3Client> {
    const signature = `${config.endpoint}|${config.bucket}|${config.accessKeyId}`;
    if (this.client && this.clientSignature === signature) return this.client;
    this.client = new S3Client({
      region: config.region || 'auto',
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      // R2 PutObject does not implement the flexible checksum headers
      // the AWS SDK sends by default (x-amz-checksum-algorithm / aws-chunked).
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    this.clientSignature = signature;
    return this.client;
  }

  private async putObject(
    config: R2Config,
    key: string,
    body: Buffer,
    options: {
      contentType: string;
      contentDisposition?: string;
      metadata?: Record<string, string>;
    },
  ) {
    const client = await this.clientFor(config);
    await client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: body,
        ContentType: options.contentType,
        ContentDisposition: options.contentDisposition,
        Metadata: options.metadata,
      }),
    );
  }

  private async getObjectStream(
    config: R2Config,
    key: string,
  ): Promise<MediaObjectStream> {
    const client = await this.clientFor(config);
    const result = await client.send(
      new GetObjectCommand({ Bucket: config.bucket, Key: key }),
    );
    const body = result.Body as Readable | undefined;
    if (!body) throw new Error('Empty object body');
    return {
      body,
      contentLength:
        typeof result.ContentLength === 'number' ? result.ContentLength : null,
    };
  }

  private async deleteObject(config: R2Config, key: string) {
    const client = await this.clientFor(config);
    await client.send(
      new DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
    );
  }

  private async deleteObjectQuietly(config: R2Config, key: string) {
    try {
      await this.deleteObject(config, key);
    } catch (error) {
      this.logger.warn(`Could not delete object: ${errorMessage(error)}`);
    }
  }
}

export function configFromEnv(): R2Config {
  return {
    provider: 'cloudflare-r2',
    accountId: process.env.R2_ACCOUNT_ID || '',
    endpoint: (process.env.R2_ENDPOINT || '').replace(/\/$/, ''),
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    apiToken: process.env.R2_API_TOKEN || '',
    bucket: process.env.R2_BUCKET || 'opal-media',
    region: 'auto',
  };
}

export function tokenFromPublicPath(publicPath: string): string | null {
  const index = publicPath.indexOf(MEDIA_PATH_PREFIX);
  if (index < 0) return null;
  const token = publicPath
    .slice(index + MEDIA_PATH_PREFIX.length)
    .split(/[?#/]/)[0];
  return TOKEN_RE.test(token) ? token : null;
}

function copySource(bucket: string, key: string): string {
  return `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

function toRecord(row: Record<string, any>): StoredFileRecord {
  return {
    id: row.id,
    userId: row.user_id || null,
    spaceId: row.space_id || null,
    kind: row.kind,
    objectKey: row.object_key,
    token: row.public_token,
    mimeType: row.mime_type || 'application/octet-stream',
    sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
    originalFilename: row.original_filename || null,
    sha256: row.sha256 || null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
