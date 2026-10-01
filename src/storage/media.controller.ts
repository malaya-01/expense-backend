import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { Public } from 'src/helper/decorators/public.decorator';
import { ObjectStorageService } from './object-storage.service';

@Controller('media')
export class MediaController {
  constructor(private readonly storage: ObjectStorageService) {}

  @Public()
  @Get(':token')
  async read(@Param('token') token: string, @Res() res: Response) {
    if (!/^[a-f0-9]{32,64}$/i.test(token)) {
      throw new NotFoundException('File not found');
    }
    try {
      const file = await this.storage.readPublic(token);
      res.setHeader('Content-Type', file.mimeType);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.send(file.body);
    } catch {
      throw new NotFoundException('File not found');
    }
  }
}
