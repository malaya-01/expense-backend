import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';

const MATCH_DISTANCE = 0.5;

export function faceMatchDistance() {
  return MATCH_DISTANCE;
}

function templateKey(): Buffer {
  const secret =
    process.env.FACE_TEMPLATE_KEY ||
    process.env.JWT_SECRET ||
    process.env.JWT_ACCESS_SECRET ||
    '';
  if (secret.length < 16) {
    throw new ServiceUnavailableException(
      'Face storage key is not configured.',
    );
  }
  return scryptSync(secret, 'opal-face-template-v1', 32);
}

export function assertDescriptor(values: number[]): number[] {
  if (!Array.isArray(values) || values.length < 64 || values.length > 256) {
    throw new BadRequestException('Face data is not valid.');
  }
  const next: number[] = [];
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 4) {
      throw new BadRequestException('Face data is not valid.');
    }
    next.push(value);
  }
  return next;
}

export function encryptFaceTemplate(descriptor: number[]): Record<string, string | number> {
  const key = templateKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(
    JSON.stringify({ descriptor: assertDescriptor(descriptor) }),
    'utf8',
  );
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

export function decryptFaceTemplate(payload: unknown): number[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const row = payload as Record<string, unknown>;
  if (Array.isArray(row.descriptor)) {
    try {
      return assertDescriptor(row.descriptor as number[]);
    } catch {
      return null;
    }
  }
  if (row.alg !== 'aes-256-gcm' || typeof row.iv !== 'string' || typeof row.tag !== 'string' || typeof row.data !== 'string') {
    return null;
  }
  try {
    const key = templateKey();
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(row.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(row.data, 'base64')),
      decipher.final(),
    ]);
    const parsed = JSON.parse(plain.toString('utf8')) as { descriptor?: number[] };
    return assertDescriptor(parsed.descriptor || []);
  } catch {
    return null;
  }
}

export function faceDistance(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length < 64) return 1;
  let sum = 0;
  for (let i = 0; i < left.length; i += 1) {
    const delta = left[i] - right[i];
    sum += delta * delta;
  }
  return Math.sqrt(sum);
}
