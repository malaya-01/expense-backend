/**
 * Move Cloudflare R2 objects from the legacy layout
 *   {kind}/{userId}/{token}.{ext}          (avatar/..., receipt/...)
 * to the per-user layout built by src/storage/storage-keys.ts
 *   users/{userId}/avatar/{id}.{ext}
 *   users/{userId}/receipts/{YYYY}/{MM}/{yyyymmdd}-{merchant|receipt}-{id}.{ext}
 *
 * Phase 2 moves collaborative-space receipts stored inline in
 * space_expenses.receipt_base64 into
 *   spaces/{spaceId}/receipts/{YYYY}/{MM}/{yyyymmdd}-{title|receipt}-{id}.{ext}
 * (PutObject + stored_files row with space_id + space_expenses.receipt_file_id),
 * then NULLs receipt_base64 for that row.
 *
 * Phase 3 moves AI-advisor documents stored in ai_documents.content (BYTEA)
 * into users/{userId}/documents/{YYYY}/{MM}/{slug|document}-{id}.{ext}
 * (PutObject + stored_files row + ai_documents.stored_file_id), then NULLs
 * content for that row.
 *
 * Dry run is the DEFAULT. Nothing is written unless --apply is passed.
 *
 * Usage:
 *   npm run storage:migrate-layout                    # dry run (plan only)
 *   npm run storage:migrate-layout -- --apply         # copy, repoint DB, delete old
 *   options:
 *     --apply           execute (CopyObject -> UPDATE stored_files/receipts -> DeleteObject)
 *     --keep-old        with --apply: leave the legacy object in place
 *     --hash            with --apply: download each object to backfill stored_files.sha256
 *     --only <phase>    layout | space-receipts | ai-documents (default: all)
 *     --user <uuid>     layout / ai-documents phases: only this user's files
 *     --space <uuid>    space-receipts phase: only this space
 *     --limit <n>       process at most n rows per phase this run
 *     --verbose         print every planned move (default: first 20)
 *
 * Idempotent and resumable: the target key is derived from the stored_files
 * id / space expense id (stable short id), the DB row is only repointed while
 * it still has the old key (or still has inline base64), and an
 * already-copied object is detected / overwritten on re-run. Existing public
 * URLs (/api/media/<token>) never change. Invalid inline receipts (not a real
 * image/PDF) are reported and left in place.
 *
 * Env / DB loading follows scripts/run-migrations.js (.env, USE_SUPABASE ->
 * .env.supabase, PG_SSL). R2 credentials come from app_config.cloudflare_r2
 * (what the app uses), falling back to R2_* env vars.
 */
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { existsSync } = fs;

function resolveEnvPath(fileName) {
  const candidates = [
    path.resolve(process.cwd(), fileName),
    path.resolve(process.cwd(), 'expense-backend', fileName),
    path.resolve(__dirname, '..', fileName),
  ];
  return candidates.find(existsSync);
}

const basePath = resolveEnvPath('.env');
require('dotenv').config(basePath ? { path: basePath } : undefined);

const useSupabase =
  String(process.env.USE_SUPABASE || '')
    .trim()
    .toLowerCase() === 'true';
if (useSupabase) {
  const supabasePath = resolveEnvPath('.env.supabase');
  if (supabasePath) {
    require('dotenv').config({ path: supabasePath, override: true });
  }
}

const useSsl =
  String(process.env.PG_SSL || '')
    .trim()
    .toLowerCase() === 'true' || useSupabase;

// ------------------------------------------------------------------ args

const argv = process.argv.slice(2);
function flag(name) {
  return argv.includes(`--${name}`);
}
function option(name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}
const APPLY = flag('apply');
const KEEP_OLD = flag('keep-old');
const HASH = flag('hash');
const VERBOSE = flag('verbose');
const ONLY_USER = option('user');
const ONLY_SPACE = option('space');
const ONLY_PHASE = option('only');
if (ONLY_PHASE && !['layout', 'space-receipts', 'ai-documents'].includes(ONLY_PHASE)) {
  console.error('--only must be "layout", "space-receipts" or "ai-documents"');
  process.exit(1);
}
const RUN_LAYOUT = !ONLY_PHASE || ONLY_PHASE === 'layout';
const RUN_SPACE_RECEIPTS = !ONLY_PHASE || ONLY_PHASE === 'space-receipts';
const RUN_AI_DOCUMENTS = !ONLY_PHASE || ONLY_PHASE === 'ai-documents';
const LIMIT = option('limit') ? Math.max(1, Number(option('limit'))) : null;
const LEGACY_PREFIXES = ['avatar/', 'receipt/', 'face-login/', 'face_preview/'];

// ------------------------------------------------- shared key builder

/**
 * Load src/storage/storage-keys.ts so the script and the app build keys
 * identically. Prefers the TypeScript source (ts-node, transpile only) and
 * falls back to the compiled dist/ output.
 */
function loadStorageKeys() {
  const source = path.join(__dirname, '..', 'src', 'storage', 'storage-keys.ts');
  try {
    require('ts-node').register({
      transpileOnly: true,
      compilerOptions: { module: 'commonjs' },
    });
    return require(source);
  } catch (sourceError) {
    const compiled = path.join(__dirname, '..', 'dist', 'storage', 'storage-keys.js');
    if (existsSync(compiled)) return require(compiled);
    throw new Error(
      `Cannot load storage-keys (install dev deps or run "npm run build"): ${sourceError.message}`,
    );
  }
}

// ------------------------------------------------------------- helpers

function createPool() {
  const { Pool } = require('pg');
  return new Pool({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT || 5432),
    user: process.env.PG_USERNAME,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
    ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
}

async function loadR2Config(pool) {
  let row = null;
  try {
    const found = await pool.query(
      `SELECT config FROM app_config WHERE key = 'cloudflare_r2'`,
    );
    row = found.rows[0] ? found.rows[0].config : null;
  } catch {
    row = null;
  }
  if (row && row.bucket && row.accessKeyId && row.secretAccessKey && row.endpoint) {
    return row;
  }
  const env = {
    endpoint: (process.env.R2_ENDPOINT || '').trim().replace(/\/$/, ''),
    accessKeyId: (process.env.R2_ACCESS_KEY_ID || '').trim(),
    secretAccessKey: (process.env.R2_SECRET_ACCESS_KEY || '').trim(),
    bucket: (process.env.R2_BUCKET || '').trim() || 'opal-media',
    region: 'auto',
  };
  return env.endpoint && env.accessKeyId && env.secretAccessKey ? env : null;
}

function createS3(config) {
  const { S3Client } = require('@aws-sdk/client-s3');
  return new S3Client({
    region: config.region || 'auto',
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

async function objectExists(s3, bucket, key) {
  const { HeadObjectCommand } = require('@aws-sdk/client-s3');
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error) {
    const status = error && error.$metadata && error.$metadata.httpStatusCode;
    if (status === 404 || (error && error.name === 'NotFound')) return false;
    throw error;
  }
}

async function sha256Of(s3, bucket, key) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const hash = createHash('sha256');
  for await (const chunk of result.Body) hash.update(chunk);
  return hash.digest('hex');
}

function copySource(bucket, key) {
  return `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/** Stable 12-char id per stored_files row so re-runs target the same key. */
function stableShortId(fileId) {
  return createHash('sha256').update(String(fileId)).digest('hex').slice(0, 12);
}

function isLegacyKey(key) {
  return !/^(users|spaces)\//.test(key);
}

async function listPrefix(s3, bucket, prefix) {
  const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
  let count = 0;
  let bytes = 0;
  let token;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    for (const item of page.Contents || []) {
      count += 1;
      bytes += Number(item.Size || 0);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return { count, bytes };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ------------------------------------------------ phase 2: space receipts

function decodeInlineReceipt(value) {
  const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,/i.exec(value || '');
  const raw = match ? value.slice(match[0].length) : value || '';
  return {
    body: Buffer.from(raw.replace(/\s+/g, ''), 'base64'),
    mime: (match && match[1]) || null,
  };
}

async function migrateSpaceReceipts({ pool, s3, config, keys }) {
  const { randomBytes } = require('crypto');
  const summary = { found: 0, planned: 0, moved: 0, invalid: 0, skipped: 0, failed: 0, bytes: 0 };
  const samples = [];
  const params = [];
  let spaceFilter = '';
  if (ONLY_SPACE) {
    if (!keys.isUuid(ONLY_SPACE)) throw new Error('--space must be a UUID');
    params.push(ONLY_SPACE);
    spaceFilter = `AND e.space_id = $${params.length}`;
  }
  let limitClause = '';
  if (LIMIT) {
    params.push(LIMIT);
    limitClause = `LIMIT $${params.length}`;
  }
  const rows = await pool.query(
    `SELECT e.id, e.space_id, e.created_by, e.title, e.receipt_name,
            e.receipt_mime_type, to_char(e.expense_date, 'YYYY-MM-DD') AS expense_date
     FROM space_expenses e
     WHERE e.receipt_base64 IS NOT NULL
       AND e.receipt_file_id IS NULL
       AND e.deleted_at IS NULL
       ${spaceFilter}
     ORDER BY e.created_at
     ${limitClause}`,
    params,
  );
  const deleted = await pool.query(
    `SELECT COUNT(*)::int AS n FROM space_expenses
     WHERE receipt_base64 IS NOT NULL AND deleted_at IS NOT NULL`,
  );

  console.log('\n--- Phase 2: space expense receipts (receipt_base64 -> R2) ---');
  for (const row of rows.rows) {
    summary.found += 1;
    try {
      // Load one payload at a time (base64 can be several MB).
      const payload = await pool.query(
        `SELECT receipt_base64 FROM space_expenses WHERE id = $1`,
        [row.id],
      );
      const inline = payload.rows[0] && payload.rows[0].receipt_base64;
      if (!inline) {
        summary.skipped += 1;
        continue;
      }
      const decoded = decodeInlineReceipt(inline);
      const checked = keys.checkUpload(
        'receipt',
        row.receipt_mime_type || decoded.mime || 'image/jpeg',
        decoded.body,
      );
      if (!checked.ok) {
        summary.invalid += 1;
        console.warn(`invalid ${row.id}: ${checked.error} (left inline)`);
        continue;
      }
      const mimeType = checked.mimeType;
      const target = keys.buildObjectKey({
        kind: 'receipt',
        userId: row.created_by,
        spaceId: row.space_id,
        mimeType,
        date: row.expense_date,
        label: row.title,
        shortId: stableShortId(row.id),
      });
      summary.planned += 1;
      summary.bytes += decoded.body.length;
      if (VERBOSE || samples.length < 20) {
        samples.push(`space_expenses ${row.id} (${formatBytes(decoded.body.length)})\n    -> ${target}`);
      }
      if (!APPLY) continue;

      const filename = keys.cleanOriginalName(row.receipt_name);
      const sha256 = keys.sha256Hex(decoded.body);
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      await s3.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: target,
          Body: decoded.body,
          ContentType: mimeType,
          ContentDisposition: keys.contentDisposition('inline', filename, mimeType),
          Metadata: {
            'user-id': row.created_by,
            'space-id': row.space_id,
            kind: 'receipt',
            sha256,
            'original-name': keys.metadataValue(filename),
          },
        }),
      );

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const existing = await client.query(
          `SELECT id FROM stored_files
           WHERE object_key = $1 AND space_id = $2 AND deleted_at IS NULL
           LIMIT 1`,
          [target, row.space_id],
        );
        let fileId = existing.rows[0] && existing.rows[0].id;
        if (!fileId) {
          const inserted = await client.query(
            `INSERT INTO stored_files
              (user_id, space_id, kind, object_key, public_token, mime_type,
               size_bytes, original_filename, sha256)
             VALUES ($1, $2, 'receipt', $3, $4, $5, $6, $7, $8)
             RETURNING id`,
            [
              row.created_by,
              row.space_id,
              target,
              randomBytes(24).toString('hex'),
              mimeType,
              decoded.body.length,
              filename,
              sha256,
            ],
          );
          fileId = inserted.rows[0].id;
        }
        const updated = await client.query(
          `UPDATE space_expenses
           SET receipt_file_id = $2,
               receipt_mime_type = $3,
               receipt_base64 = NULL,
               updated_at = NOW()
           WHERE id = $1 AND receipt_file_id IS NULL AND receipt_base64 IS NOT NULL`,
          [row.id, fileId, mimeType],
        );
        if (!updated.rowCount) {
          await client.query('ROLLBACK');
          summary.skipped += 1;
          console.warn(`skip ${row.id}: row changed during migration`);
          continue;
        }
        await client.query('COMMIT');
        summary.moved += 1;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      summary.failed += 1;
      console.error(`failed space_expenses ${row.id}: ${error.message || error}`);
    }
  }

  if (samples.length) {
    console.log(`\nPlanned space receipt uploads${VERBOSE ? '' : ' (first 20)'}:`);
    for (const line of samples) console.log(`  ${line}`);
  }
  console.log('\nSpace receipts summary:');
  console.log(`  inline receipts found:         ${summary.found}`);
  console.log(`  planned uploads:               ${summary.planned} (${formatBytes(summary.bytes)})`);
  console.log(`  invalid (left inline):         ${summary.invalid}`);
  if (APPLY) {
    console.log(`  moved to R2 + base64 cleared:  ${summary.moved}`);
    console.log(`  failed (re-run to retry):      ${summary.failed}`);
  }
  console.log(`  skipped:                       ${summary.skipped}`);
  console.log(
    `  deleted expenses still holding base64: ${deleted.rows[0].n} (not migrated; can be NULLed)`,
  );
  if (summary.failed) process.exitCode = 1;
}

// ---------------------------------------------- phase 3: AI documents

async function migrateAiDocuments({ pool, s3, config, keys }) {
  const { randomBytes } = require('crypto');
  const summary = { found: 0, planned: 0, moved: 0, invalid: 0, skipped: 0, failed: 0, bytes: 0 };
  const samples = [];
  const params = [];
  let userFilter = '';
  if (ONLY_USER) {
    if (!keys.isUuid(ONLY_USER)) throw new Error('--user must be a UUID');
    params.push(ONLY_USER);
    userFilter = `AND d.user_id = $${params.length}`;
  }
  let limitClause = '';
  if (LIMIT) {
    params.push(LIMIT);
    limitClause = `LIMIT $${params.length}`;
  }
  const rows = await pool.query(
    `SELECT d.id, d.user_id, d.name, d.mime_type, d.created_at,
            octet_length(d.content) AS size_bytes, u.timezone
     FROM ai_documents d
     LEFT JOIN users u ON u.id = d.user_id
     WHERE d.content IS NOT NULL
       AND d.stored_file_id IS NULL
       AND d.deleted_at IS NULL
       ${userFilter}
     ORDER BY d.created_at
     ${limitClause}`,
    params,
  );
  const deleted = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ai_documents
     WHERE content IS NOT NULL AND deleted_at IS NOT NULL`,
  );

  console.log('\n--- Phase 3: AI-advisor documents (ai_documents.content -> R2) ---');
  for (const row of rows.rows) {
    summary.found += 1;
    try {
      if (!row.user_id || !keys.isUuid(row.user_id)) {
        summary.skipped += 1;
        console.warn(`skip ai_documents ${row.id}: no owning user`);
        continue;
      }
      // Load one payload at a time (up to 5 MB each).
      const payload = await pool.query(`SELECT content FROM ai_documents WHERE id = $1`, [
        row.id,
      ]);
      const body = payload.rows[0] && payload.rows[0].content;
      if (!body || !body.length) {
        summary.skipped += 1;
        continue;
      }
      const checked = keys.checkUpload('document', row.mime_type, body);
      if (!checked.ok) {
        summary.invalid += 1;
        console.warn(`invalid ai_documents ${row.id}: ${checked.error} (left in Postgres)`);
        continue;
      }
      const mimeType = checked.mimeType;
      const target = keys.buildObjectKey({
        kind: 'document',
        userId: row.user_id,
        mimeType,
        date: row.created_at,
        timeZone: row.timezone,
        label: String(row.name || '').replace(/\.[a-z0-9]{1,8}$/i, ''),
        shortId: stableShortId(row.id),
      });
      summary.planned += 1;
      summary.bytes += body.length;
      if (VERBOSE || samples.length < 20) {
        samples.push(`ai_documents ${row.id} (${formatBytes(body.length)})\n    -> ${target}`);
      }
      if (!APPLY) continue;

      const filename = keys.cleanOriginalName(row.name);
      const sha256 = keys.sha256Hex(body);
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      await s3.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: target,
          Body: body,
          ContentType: mimeType,
          ContentDisposition: keys.contentDisposition('inline', filename, mimeType),
          Metadata: {
            'user-id': row.user_id,
            kind: 'document',
            sha256,
            'original-name': keys.metadataValue(filename),
          },
        }),
      );

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const existing = await client.query(
          `SELECT id FROM stored_files
           WHERE object_key = $1 AND user_id = $2 AND deleted_at IS NULL
           LIMIT 1`,
          [target, row.user_id],
        );
        let fileId = existing.rows[0] && existing.rows[0].id;
        if (!fileId) {
          const inserted = await client.query(
            `INSERT INTO stored_files
              (user_id, kind, object_key, public_token, mime_type,
               size_bytes, original_filename, sha256)
             VALUES ($1, 'document', $2, $3, $4, $5, $6, $7)
             RETURNING id`,
            [
              row.user_id,
              target,
              randomBytes(24).toString('hex'),
              mimeType,
              body.length,
              filename,
              sha256,
            ],
          );
          fileId = inserted.rows[0].id;
        }
        const updated = await client.query(
          `UPDATE ai_documents
           SET stored_file_id = $2, content = NULL
           WHERE id = $1 AND stored_file_id IS NULL AND content IS NOT NULL`,
          [row.id, fileId],
        );
        if (!updated.rowCount) {
          await client.query('ROLLBACK');
          summary.skipped += 1;
          console.warn(`skip ai_documents ${row.id}: row changed during migration`);
          continue;
        }
        await client.query('COMMIT');
        summary.moved += 1;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      summary.failed += 1;
      console.error(`failed ai_documents ${row.id}: ${error.message || error}`);
    }
  }

  if (samples.length) {
    console.log(`\nPlanned document uploads${VERBOSE ? '' : ' (first 20)'}:`);
    for (const line of samples) console.log(`  ${line}`);
  }
  console.log('\nAI documents summary:');
  console.log(`  documents in Postgres found:   ${summary.found}`);
  console.log(`  planned uploads:               ${summary.planned} (${formatBytes(summary.bytes)})`);
  console.log(`  invalid (left in Postgres):    ${summary.invalid}`);
  if (APPLY) {
    console.log(`  moved to R2 + content cleared: ${summary.moved}`);
    console.log(`  failed (re-run to retry):      ${summary.failed}`);
  }
  console.log(`  skipped:                       ${summary.skipped}`);
  console.log(
    `  deleted documents still holding content: ${deleted.rows[0].n} (not migrated; can be NULLed)`,
  );
  if (summary.failed) process.exitCode = 1;
}

// ---------------------------------------------------------------- main

async function main() {
  const keys = loadStorageKeys();
  const pool = createPool();
  const summary = {
    scanned: 0,
    planned: 0,
    moved: 0,
    repointedOnly: 0,
    skipped: 0,
    missing: 0,
    failed: 0,
  };
  const samples = [];

  console.log(
    APPLY
      ? '=== R2 layout migration: APPLY ==='
      : '=== R2 layout migration: DRY RUN (pass --apply to execute) ===',
  );

  try {
    const hasMetadataColumns = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE (table_name = 'stored_files' AND column_name = 'legacy_object_key')
          OR (table_name = 'space_expenses' AND column_name = 'receipt_file_id')
          OR (table_name = 'ai_documents' AND column_name = 'stored_file_id')`,
    );
    if ((hasMetadataColumns.rowCount || 0) < 3) {
      throw new Error(
        'Run "npm run migration:up" first (1786300000000_storage-layout-metadata.sql, 1786320000000_ai-documents-r2.sql).',
      );
    }

    const config = await loadR2Config(pool);
    const s3 = config ? createS3(config) : null;
    if (APPLY && !s3) {
      throw new Error('R2 configuration is missing (app_config.cloudflare_r2 or R2_* env).');
    }
    if (!s3) {
      console.log('R2 credentials not available: planning from the database only.');
    }

    if (RUN_LAYOUT) {
      const params = [];
      let userFilter = '';
      if (ONLY_USER) {
        if (!keys.isUuid(ONLY_USER)) throw new Error('--user must be a UUID');
        params.push(ONLY_USER);
        userFilter = `AND f.user_id = $${params.length}`;
      }
      let limitClause = '';
      if (LIMIT) {
        params.push(LIMIT);
        limitClause = `LIMIT $${params.length}`;
      }
      const rows = await pool.query(
        `SELECT DISTINCT ON (f.id)
                f.id, f.user_id, f.kind, f.object_key, f.mime_type,
                f.original_filename, f.sha256, f.created_at,
                u.timezone,
                to_char(t.date, 'YYYY-MM-DD') AS tx_date,
                COALESCE(NULLIF(t.merchant, ''), t.description) AS tx_label
         FROM stored_files f
         LEFT JOIN users u ON u.id = f.user_id
         LEFT JOIN receipts r
           ON r.user_id = f.user_id
          AND (r.stored_file_id = f.id OR r.file_path = f.object_key)
         LEFT JOIN ledger_transactions t
           ON t.id = r.ledger_transaction_id AND t.deleted_at IS NULL
         WHERE f.deleted_at IS NULL
           AND f.object_key NOT LIKE 'users/%'
           AND f.object_key NOT LIKE 'spaces/%'
           ${userFilter}
         ORDER BY f.id, t.date DESC NULLS LAST
         ${limitClause}`,
        params,
      );

      for (const row of rows.rows) {
        summary.scanned += 1;
        const oldKey = row.object_key;
        if (!isLegacyKey(oldKey)) continue;
        if (!row.user_id || !keys.isUuid(row.user_id)) {
          summary.skipped += 1;
          console.warn(`skip ${row.id}: no owning user`);
          continue;
        }
        if (row.kind !== 'avatar' && row.kind !== 'receipt' && row.kind !== 'document') {
          summary.skipped += 1;
          console.warn(`skip ${row.id}: unsupported kind "${row.kind}"`);
          continue;
        }
        const mimeType = keys.normalizeMime(row.mime_type) || 'image/jpeg';
        const target = keys.buildObjectKey({
          kind: row.kind,
          userId: row.user_id,
          mimeType,
          date: row.tx_date || row.created_at,
          timeZone: row.timezone,
          label: row.kind === 'receipt' ? row.tx_label : null,
          shortId: stableShortId(row.id),
        });
        summary.planned += 1;
        if (VERBOSE || samples.length < 20) samples.push(`${oldKey}\n    -> ${target}`);
        if (!APPLY) continue;

        try {
          const sourceExists = await objectExists(s3, config.bucket, oldKey);
          const targetExists = await objectExists(s3, config.bucket, target);
          if (!sourceExists && !targetExists) {
            summary.missing += 1;
            console.warn(`missing ${row.id}: ${oldKey} not found in bucket`);
            continue;
          }
          let sha256 = row.sha256 || null;
          if (sourceExists) {
            if (HASH && !sha256) sha256 = await sha256Of(s3, config.bucket, oldKey);
            const { CopyObjectCommand } = require('@aws-sdk/client-s3');
            const filename = keys.cleanOriginalName(row.original_filename);
            const metadata = {
              'user-id': row.user_id,
              kind: row.kind,
              'original-name': keys.metadataValue(filename),
              'legacy-key': keys.metadataValue(oldKey),
            };
            if (sha256) metadata.sha256 = sha256;
            await s3.send(
              new CopyObjectCommand({
                Bucket: config.bucket,
                Key: target,
                CopySource: copySource(config.bucket, oldKey),
                MetadataDirective: 'REPLACE',
                ContentType: mimeType,
                ContentDisposition: keys.contentDisposition('inline', filename, mimeType),
                Metadata: metadata,
              }),
            );
          }

          const client = await pool.connect();
          let repointed = false;
          try {
            await client.query('BEGIN');
            const updated = await client.query(
              `UPDATE stored_files
               SET object_key = $3,
                   legacy_object_key = COALESCE(legacy_object_key, $2),
                   sha256 = COALESCE(sha256, $4),
                   updated_at = NOW()
               WHERE id = $1 AND object_key = $2`,
              [row.id, oldKey, target, sha256],
            );
            repointed = updated.rowCount > 0;
            if (repointed) {
              await client.query(
                `UPDATE receipts
                 SET file_path = $3, stored_file_id = $1, updated_at = NOW()
                 WHERE user_id = $4 AND (stored_file_id = $1 OR file_path = $2)`,
                [row.id, oldKey, target, row.user_id],
              );
            }
            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }

          if (!repointed) {
            summary.skipped += 1;
            console.warn(`skip ${row.id}: row changed during migration`);
            continue;
          }
          if (sourceExists && !KEEP_OLD) {
            const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
            await s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: oldKey }));
          }
          if (sourceExists) summary.moved += 1;
          else summary.repointedOnly += 1;
        } catch (error) {
          summary.failed += 1;
          console.error(`failed ${row.id}: ${error.message || error}`);
        }
      }

      if (samples.length) {
        console.log(`\nPlanned moves${VERBOSE ? '' : ' (first 20)'}:`);
        for (const line of samples) console.log(`  ${line}`);
      }

      console.log('\nSummary:');
      console.log(`  rows with legacy keys scanned: ${summary.scanned}`);
      console.log(`  planned moves:                 ${summary.planned}`);
      if (APPLY) {
        console.log(`  moved (copy+repoint+delete):   ${summary.moved}`);
        console.log(`  repointed (already copied):    ${summary.repointedOnly}`);
        console.log(`  missing in bucket:             ${summary.missing}`);
        console.log(`  failed (re-run to retry):      ${summary.failed}`);
      }
      console.log(`  skipped:                       ${summary.skipped}`);

    }

    if (RUN_SPACE_RECEIPTS) {
      await migrateSpaceReceipts({ pool, s3, config, keys });
    }

    if (RUN_AI_DOCUMENTS) {
      await migrateAiDocuments({ pool, s3, config, keys });
    }

    if (s3) {
      console.log('\nLegacy prefixes still in the bucket:');
      for (const prefix of LEGACY_PREFIXES) {
        try {
          const stats = await listPrefix(s3, config.bucket, prefix);
          console.log(
            `  ${prefix.padEnd(14)} ${String(stats.count).padStart(6)} objects  ${formatBytes(stats.bytes)}`,
          );
        } catch (error) {
          console.log(`  ${prefix.padEnd(14)} (list failed: ${error.message || error})`);
        }
      }
      console.log(
        '  face-login/ and face_preview/ are unreferenced since 1786200000000 and can be purged.',
      );
      console.log(
        '  avatar/ and receipt/ can be purged once this script reports 0 planned moves.',
      );
    } else {
      console.log(
        `\nLegacy prefixes to purge after --apply: ${LEGACY_PREFIXES.join(', ')}`,
      );
    }
    if (summary.failed) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
