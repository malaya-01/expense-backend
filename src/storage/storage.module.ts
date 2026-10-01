import { Global, Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { ObjectStorageService } from './object-storage.service';

@Global()
@Module({
  controllers: [MediaController],
  providers: [ObjectStorageService],
  exports: [ObjectStorageService],
})
export class StorageModule {}
