import {
  Injectable,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Pool } from 'pg';
import { randomBytes } from 'crypto';
import { Readable } from 'stream';

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
  objectKey: string;
  publicPath: string;
  token: string;
  mimeType: string;
};

@Injectable()
export class ObjectStorageService {
  private client: S3Client | null = null;
  private clientBucket = '';

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

  async saveFile(input: {
    userId: string;
    kind: 'avatar' | 'receipt' | 'face_preview';
    body: Buffer;
    mimeType: string;
    filename?: string;
  }): Promise<StoredObject> {
    const config = await this.getConfig();
    const token = randomBytes(24).toString('hex');
    const ext = extensionForMime(input.mimeType);
    const objectKey = `${input.kind}/${input.userId}/${token}.${ext}`;
    await this.putObject(config, objectKey, input.body, input.mimeType);
    const inserted = await this.pgPool.query(
      `INSERT INTO stored_files
        (user_id, kind, object_key, public_token, mime_type, size_bytes, original_filename)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        input.userId,
        input.kind,
        objectKey,
        token,
        input.mimeType,
        input.body.length,
        input.filename || null,
      ],
    );
    return {
      id: inserted.rows[0].id as string,
      objectKey,
      publicPath: `/api/media/${token}`,
      token,
      mimeType: input.mimeType,
    };
  }

  async readPublic(token: string): Promise<{ body: Buffer; mimeType: string }> {
    const found = await this.pgPool.query(
      `SELECT object_key, mime_type FROM stored_files WHERE public_token = $1`,
      [token],
    );
    if (!found.rowCount) {
      throw new ServiceUnavailableException('File not found');
    }
    const config = await this.getConfig();
    const body = await this.getObject(config, found.rows[0].object_key as string);
    return {
      body,
      mimeType: (found.rows[0].mime_type as string) || 'application/octet-stream',
    };
  }

  async deletePublicPath(publicPath: string | null | undefined): Promise<void> {
    if (!publicPath) return;
    const token = tokenFromPublicPath(publicPath);
    if (!token) return;
    const found = await this.pgPool.query(
      `SELECT object_key FROM stored_files WHERE public_token = $1`,
      [token],
    );
    if (!found.rowCount) return;
    try {
      const config = await this.getConfig();
      await this.deleteObject(config, found.rows[0].object_key as string);
    } catch {
      /* object may already be gone */
    }
    await this.pgPool.query(`DELETE FROM stored_files WHERE public_token = $1`, [
      token,
    ]);
  }

  async putJson(objectKey: string, value: unknown): Promise<void> {
    const config = await this.getConfig();
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    await this.putObject(config, objectKey, body, 'application/json');
  }

  async putBytes(
    objectKey: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    const config = await this.getConfig();
    await this.putObject(config, objectKey, body, contentType);
  }

  async getJson<T>(objectKey: string): Promise<T | null> {
    try {
      const config = await this.getConfig();
      const body = await this.getObject(config, objectKey);
      return JSON.parse(body.toString('utf8')) as T;
    } catch {
      return null;
    }
  }

  async deleteKey(objectKey: string): Promise<void> {
    const config = await this.getConfig();
    await this.deleteObject(config, objectKey);
  }

  private async clientFor(config: R2Config): Promise<S3Client> {
    if (this.client && this.clientBucket === config.bucket) return this.client;
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
    this.clientBucket = config.bucket;
    return this.client;
  }

  private async putObject(
    config: R2Config,
    key: string,
    body: Buffer,
    contentType: string,
  ) {
    const client = await this.clientFor(config);
    await client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  private async getObject(config: R2Config, key: string): Promise<Buffer> {
    const client = await this.clientFor(config);
    const result = await client.send(
      new GetObjectCommand({ Bucket: config.bucket, Key: key }),
    );
    return streamToBuffer(result.Body as Readable);
  }

  private async deleteObject(config: R2Config, key: string) {
    const client = await this.clientFor(config);
    await client.send(
      new DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
    );
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

function extensionForMime(mime: string) {
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('pdf')) return 'pdf';
  if (mime.includes('json')) return 'json';
  return 'jpg';
}

function tokenFromPublicPath(publicPath: string): string | null {
  const marker = '/api/media/';
  const index = publicPath.indexOf(marker);
  if (index < 0) return null;
  const token = publicPath.slice(index + marker.length).split('?')[0];
  return token && !token.includes('..') ? token : null;
}

async function streamToBuffer(body: Readable | undefined): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
