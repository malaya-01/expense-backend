import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import appConfiguration from 'src/app.configuration';

export type EncryptedBlob = {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
};

function resolveKey(): Buffer {
  const raw = appConfiguration().AI.CREDENTIALS_ENCRYPTION_KEY;
  if (!raw || String(raw).trim().length < 16) {
    throw new BadRequestException(
      'AI_CREDENTIALS_ENCRYPTION_KEY is not configured on the server. Add a 32-byte hex/base64 secret to .env.',
    );
  }
  // Accept 64-char hex, base64, or arbitrary passphrase (hashed to 32 bytes)
  const value = String(raw).trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, 'hex');
  }
  try {
    const b64 = Buffer.from(value, 'base64');
    if (b64.length === 32) return b64;
  } catch {
    /* fall through */
  }
  return createHash('sha256').update(value).digest();
}

export function encryptSecret(plainText: string): EncryptedBlob {
  const key = resolveKey();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(plainText, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return { ciphertext, nonce, tag };
}

export function decryptSecret(blob: EncryptedBlob): string {
  const key = resolveKey();
  const decipher = createDecipheriv('aes-256-gcm', key, blob.nonce);
  decipher.setAuthTag(blob.tag);
  const plain = Buffer.concat([
    decipher.update(blob.ciphertext),
    decipher.final(),
  ]);
  return plain.toString('utf8');
}

export function maskSecret(value?: string | null, visible = 4): string | null {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (trimmed.length <= visible) return '••••';
  return `${'•'.repeat(Math.min(12, trimmed.length - visible))}${trimmed.slice(-visible)}`;
}

export function hasEncryptionKeyConfigured(): boolean {
  const raw = appConfiguration().AI.CREDENTIALS_ENCRYPTION_KEY;
  return Boolean(raw && String(raw).trim().length >= 16);
}
