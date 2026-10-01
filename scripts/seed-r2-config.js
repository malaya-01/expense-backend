/**
 * Store the Cloudflare R2 settings from .env into app_config as JSON.
 * Creates the media bucket when it does not exist yet.
 * Never prints secrets.
 */
const path = require('path');
const { existsSync } = require('fs');
const { Pool } = require('pg');

const envPath = path.resolve(process.cwd(), '.env');
require('dotenv').config(existsSync(envPath) ? { path: envPath } : undefined);

const accountId = (process.env.R2_ACCOUNT_ID || '').trim();
const endpoint = (process.env.R2_ENDPOINT || '').trim();
const accessKeyId = (process.env.R2_ACCESS_KEY_ID || '').trim();
const secretAccessKey = (process.env.R2_SECRET_ACCESS_KEY || '').trim();
const apiToken = (process.env.R2_API_TOKEN || '').trim();
const bucket = (process.env.R2_BUCKET || '').trim() || 'opal-media';

if (!accountId || !endpoint || !accessKeyId || !secretAccessKey) {
  console.error('R2 settings are incomplete in .env');
  process.exit(1);
}

async function ensureBucket() {
  if (!apiToken) {
    console.log('No API token; skipped bucket create. Using', bucket);
    return;
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets`;
  const listed = await fetch(url, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  const listBody = await listed.json().catch(() => ({}));
  if (!listed.ok || listBody.success === false) {
    const message =
      listBody?.errors?.[0]?.message || `list failed (${listed.status})`;
    throw new Error(`Could not list R2 buckets: ${message}`);
  }
  const names = (listBody.result?.buckets || listBody.result || [])
    .map((item) => item.name)
    .filter(Boolean);
  if (names.includes(bucket)) {
    console.log('Bucket already exists:', bucket);
    return;
  }
  const created = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: bucket }),
  });
  const createBody = await created.json().catch(() => ({}));
  if (!created.ok || createBody.success === false) {
    const message =
      createBody?.errors?.[0]?.message || `create failed (${created.status})`;
    throw new Error(`Could not create bucket ${bucket}: ${message}`);
  }
  console.log('Created bucket:', bucket);
}

async function main() {
  await ensureBucket();
  const pool = new Pool({
    host: process.env.PG_HOST || 'localhost',
    port: Number(process.env.PG_PORT || 5432),
    user: process.env.PG_USERNAME,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
    ssl:
      String(process.env.PG_SSL || '').toLowerCase() === 'true'
        ? { rejectUnauthorized: false }
        : undefined,
  });
  const config = {
    provider: 'cloudflare-r2',
    accountId,
    endpoint,
    accessKeyId,
    secretAccessKey,
    apiToken,
    bucket,
    region: 'auto',
  };
  await pool.query(
    `INSERT INTO app_config (key, config)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE
       SET config = EXCLUDED.config, updated_at = NOW()`,
    ['cloudflare_r2', JSON.stringify(config)],
  );
  await pool.end();
  console.log('Stored Cloudflare R2 configuration in app_config');
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
