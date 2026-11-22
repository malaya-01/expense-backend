import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { createInterface } from 'readline';
import { tmpdir } from 'os';
import { join } from 'path';

export type MirageReceipt = {
  text: string;
  fields: Record<string, unknown> | null;
};

type WorkerReply = {
  id?: string;
  ok?: boolean;
  fatal?: boolean;
  error?: string;
  text?: string;
  fields?: Record<string, unknown> | null;
};

/**
 * A local read can stand in for the vision model when Mirage's transcript
 * actually contains writing and a digit. Short or digit-free reads fall
 * through to the image model.
 */
export function transcriptCanReplaceImage(text: string | null | undefined): boolean {
  const trimmed = String(text || '').trim();
  if (trimmed.length < 24) return false;
  if (!/\d/.test(trimmed)) return false;
  const letters = trimmed.replace(/[^A-Za-z]/g, '');
  return letters.length >= 8;
}

/** True when `amount` is printed in the transcript, not merely invented. */
export function amountAppearsIn(amount: number, text: string): boolean {
  if (!Number.isFinite(amount) || amount <= 0) return false;
  const rounded = Math.round(amount * 100) / 100;
  const fixed = rounded.toFixed(2);
  const whole = String(Math.trunc(rounded));
  const normalized = text
    .replace(/[₹$€£]/g, ' ')
    .replace(/,(?=\d{3}(?:\D|$))/g, '');
  const has = (token: string) =>
    new RegExp(`(?<![\\d.])${token.replace('.', '\\.')}(?![\\d])`).test(normalized);
  if (has(fixed)) return true;
  return has(whole);
}

/**
 * Needle's fields become the same JSON the receipt parser already accepts,
 * but only when the amount is visible in the Mirage transcript.
 */
export function mirageFieldsToReceiptJson(
  read: MirageReceipt,
): Record<string, unknown> | null {
  const fields = read.fields;
  if (!fields) return null;
  const amount = asPositiveAmount(fields.grand_total ?? fields.amount);
  if (amount == null || !amountAppearsIn(amount, read.text)) return null;
  return {
    merchant: fields.merchant ?? null,
    description: fields.description ?? null,
    notes: fields.notes ?? null,
    grand_total: amount,
    amount,
    currency: fields.currency ?? null,
    date: fields.date ?? null,
    date_raw: fields.date ?? null,
    time: fields.time ?? null,
    payment_status: fields.payment_status ?? null,
    transaction_type: fields.transaction_type ?? null,
    payment_method: fields.payment_method ?? null,
    confidence: { merchant: 0.6, total: 0.75, date: 0.55 },
  };
}

function asPositiveAmount(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

let disabled = false;
let worker: ChildProcessWithoutNullStreams | null = null;
const pending = new Map<
  string,
  {
    resolve: (reply: WorkerReply) => void;
    timer: NodeJS.Timeout;
  }
>();

function mirageEnabled(): boolean {
  // Receipt reading runs on the phone. This server worker stays off unless
  // a deployment explicitly opts in, so it cannot add a Python wait to scans.
  const flag = String(process.env.MIRAGE_OCR ?? '').toLowerCase();
  if (flag !== '1' && flag !== 'true' && flag !== 'on') return false;
  return !disabled;
}

function timeoutMs(): number {
  const n = Number(process.env.MIRAGE_TIMEOUT_MS || 20_000);
  return Number.isFinite(n) && n >= 1000 ? n : 20_000;
}

function scriptPath(): string {
  return (
    process.env.MIRAGE_SCRIPT ||
    join(process.cwd(), 'scripts', 'mirage_receipt.py')
  );
}

function pythonCommand(): string {
  if (process.env.MIRAGE_PYTHON) return process.env.MIRAGE_PYTHON;
  return process.platform === 'win32' ? 'python' : 'python3';
}

function disableWorker(reason: string) {
  disabled = true;
  console.warn(`[Mirage] local receipt OCR off: ${reason}`);
  for (const [id, waiter] of pending) {
    clearTimeout(waiter.timer);
    waiter.resolve({ ok: false, error: reason });
    pending.delete(id);
  }
  if (worker) {
    worker.kill();
    worker = null;
  }
}

function ensureWorker(): ChildProcessWithoutNullStreams {
  if (worker && !worker.killed) return worker;
  const child = spawn(pythonCommand(), ['-u', scriptPath()], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CACTUS_TELEMETRY: '0' },
  });
  worker = child;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let reply: WorkerReply;
    try {
      reply = JSON.parse(line) as WorkerReply;
    } catch {
      return;
    }
    if (reply.fatal) {
      disableWorker(reply.error || 'cactus-compute is not installed');
      return;
    }
    if (!reply.id) return;
    const waiter = pending.get(reply.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    pending.delete(reply.id);
    waiter.resolve(reply);
  });
  child.on('error', (error) => {
    disableWorker(error.message || 'failed to start Mirage');
  });
  child.on('exit', () => {
    if (worker === child) worker = null;
    if (pending.size) {
      disableWorker('Mirage worker exited');
    }
  });
  return child;
}

function askWorker(imagePath: string): Promise<WorkerReply> {
  const child = ensureWorker();
  const id = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: 'timed out' });
    }, timeoutMs());
    pending.set(id, { resolve, timer });
    child.stdin.write(`${JSON.stringify({ id, path: imagePath })}\n`);
  });
}

/**
 * Read a receipt image locally. Returns null when Mirage is off, missing,
 * or did not produce text — the caller keeps the paid vision path.
 */
export async function readReceiptWithMirage(
  dataBase64: string,
  mime: string,
): Promise<MirageReceipt | null> {
  if (!mirageEnabled() || !mime.startsWith('image/')) return null;
  const body = Buffer.from(dataBase64 || '', 'base64');
  if (!body.length) return null;
  const ext = mime.includes('png')
    ? 'png'
    : mime.includes('webp')
      ? 'webp'
      : 'jpg';
  const dir = await mkdtemp(join(tmpdir(), 'mirage-'));
  try {
    const imagePath = join(dir, `receipt.${ext}`);
    await writeFile(imagePath, body);
    const reply = await askWorker(imagePath);
    const text = String(reply.text || '').trim();
    if (!reply.ok || !text) return null;
    return {
      text,
      fields:
        reply.fields && typeof reply.fields === 'object' ? reply.fields : null,
    };
  } catch (error: any) {
    console.warn(`[Mirage] ${error?.message || error}`);
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
