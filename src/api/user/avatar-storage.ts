import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { BadRequestException } from '@nestjs/common';

export const AVATAR_UPLOAD_DIR = join(process.cwd(), 'uploads', 'avatars');

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
]);

export function ensureAvatarUploadDir() {
  if (!existsSync(AVATAR_UPLOAD_DIR)) {
    mkdirSync(AVATAR_UPLOAD_DIR, { recursive: true });
  }
}

export function assertAvatarFile(file?: Express.Multer.File) {
  if (!file) throw new BadRequestException('Avatar file is required');
  if (!ALLOWED_MIME.has(file.mimetype)) {
    throw new BadRequestException('Only JPEG, PNG, WebP, or GIF images are allowed');
  }
  if (file.size > 5 * 1024 * 1024) {
    throw new BadRequestException('Avatar must be 5MB or smaller');
  }
}

export function extensionForMime(mime: string) {
  switch (mime) {
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return 'jpg';
  }
}

export function buildAvatarFilename(userId: string, mime: string) {
  return `${userId}-${Date.now()}-${randomUUID().slice(0, 8)}.${extensionForMime(mime)}`;
}

/** Public path stored in DB, e.g. /uploads/avatars/xyz.jpg */
export function publicAvatarPath(filename: string) {
  return `/uploads/avatars/${filename}`;
}

export function absolutePathFromPublicAvatar(avatarUrl: string | null | undefined) {
  if (!avatarUrl) return null;
  if (!avatarUrl.startsWith('/uploads/avatars/')) return null;
  const filename = avatarUrl.split('/').pop();
  if (!filename || filename.includes('..')) return null;
  return join(AVATAR_UPLOAD_DIR, filename);
}

export function deleteAvatarFile(avatarUrl: string | null | undefined) {
  const abs = absolutePathFromPublicAvatar(avatarUrl);
  if (!abs) return;
  try {
    if (existsSync(abs)) unlinkSync(abs);
  } catch {
    // Best-effort cleanup.
  }
}
