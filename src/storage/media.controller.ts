import {
  Controller,
  Get,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { verify } from 'jsonwebtoken';
import appConfiguration from 'src/app.configuration';
import { Public } from 'src/helper/decorators/public.decorator';
import { successResponse } from 'src/utils/response/response';
import {
  ObjectStorageService,
  StoredFileRecord,
} from './object-storage.service';
import { contentDisposition } from './storage-keys';

const TOKEN_RE = /^[a-f0-9]{32,64}$/i;

/**
 * Serves stored files by their opaque token. Object keys never leave the
 * server.
 *
 *  GET /api/media/:token              public route
 *      avatar      -> always served (public profile image)
 *      other kinds -> MEDIA_ACCESS_MODE=token (default): the 192-bit token
 *                     is a capability URL (unguessable, never listed).
 *                     MEDIA_ACCESS_MODE=signed: requires ?exp&sig from
 *                     /signed-url, or a Bearer / access_token JWT of a user
 *                     allowed to read it (see canAccess).
 *      A presented ?exp&sig is always verified (expired/forged -> 404).
 *  GET /api/media/:token/signed-url   JWT + canAccess -> short-lived URL
 *  GET /api/media/:token/download     JWT + canAccess -> attachment stream
 *
 *  canAccess: personal files -> the owning user only; space files
 *  (spaces/{spaceId}/...) -> any active member of that (live) space.
 */
@Controller('media')
export class MediaController {
  private readonly logger = new Logger(MediaController.name);

  constructor(private readonly storage: ObjectStorageService) {}

  @Public()
  @Get(':token')
  async read(
    @Param('token') token: string,
    @Query('exp') exp: string | undefined,
    @Query('sig') sig: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const file = await this.lookup(token);
    if (!(await this.mayReadPublicly(file, req, exp, sig))) {
      throw new NotFoundException('File not found');
    }
    const cache =
      file.kind === 'avatar'
        ? 'public, max-age=86400, immutable'
        : exp || sig
          ? 'private, max-age=300'
          : 'private, max-age=3600';
    await this.stream(file, res, 'inline', cache);
  }

  @Get(':token/signed-url')
  async signedUrl(
    @Param('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const file = await this.lookupOwned(token, req);
    return res
      .status(HttpStatus.OK)
      .send(successResponse(this.storage.signedMediaPath(file.token)));
  }

  @Get(':token/download')
  async download(
    @Param('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const file = await this.lookupOwned(token, req);
    await this.stream(file, res, 'attachment', 'private, no-store');
  }

  private async lookup(token: string): Promise<StoredFileRecord> {
    if (!TOKEN_RE.test(token || '')) throw new NotFoundException('File not found');
    const file = await this.storage.findByToken(token).catch(() => null);
    if (!file) throw new NotFoundException('File not found');
    return file;
  }

  /** 404 (not 403) for other users' files so tokens cannot be probed. */
  private async lookupOwned(token: string, req: Request) {
    const file = await this.lookup(token);
    const userId = (req as any).user?.id as string | undefined;
    if (!(await this.storage.canAccess(file, userId))) {
      throw new NotFoundException('File not found');
    }
    return file;
  }

  private async mayReadPublicly(
    file: StoredFileRecord,
    req: Request,
    exp: string | undefined,
    sig: string | undefined,
  ): Promise<boolean> {
    if (exp !== undefined || sig !== undefined) {
      return this.storage.verifyMediaSignature(file.token, exp, sig);
    }
    if (file.kind === 'avatar') return true;
    if (this.storage.mediaAccessMode() === 'token') return true;
    return this.storage.canAccess(file, optionalJwtUserId(req));
  }

  private async stream(
    file: StoredFileRecord,
    res: Response,
    disposition: 'inline' | 'attachment',
    cacheControl: string,
  ) {
    let object;
    try {
      object = await this.storage.openObject(file);
    } catch (error) {
      this.logger.warn(
        `Media ${file.id} unavailable: ${error instanceof Error ? error.message : error}`,
      );
      throw new NotFoundException('File not found');
    }
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader(
      'Content-Disposition',
      contentDisposition(disposition, file.originalFilename, file.mimeType),
    );
    if (object.contentLength != null) {
      res.setHeader('Content-Length', String(object.contentLength));
    }
    res.setHeader('Cache-Control', cacheControl);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (file.mimeType !== 'application/pdf') {
      // Inline PDFs need the browser viewer; everything else runs no script.
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    }
    object.body.on('error', (error) => {
      this.logger.warn(`Streaming media ${file.id} failed: ${error.message}`);
      res.destroy(error);
    });
    object.body.pipe(res);
  }
}

/** Owner identity from a Bearer header or the access_token cookie, if valid. */
function optionalJwtUserId(req: Request): string | null {
  const header = req.headers['authorization'];
  const bearer =
    typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice(7).trim()
      : '';
  const cookie = (req as any).cookies?.access_token;
  const token = bearer || (typeof cookie === 'string' ? cookie : '');
  if (!token) return null;
  try {
    const payload = verify(token, appConfiguration().JWT.SECRET) as {
      sub?: string;
      typ?: string;
    };
    if (!payload?.sub || payload.typ === 'refresh') return null;
    return payload.sub;
  } catch {
    return null;
  }
}
