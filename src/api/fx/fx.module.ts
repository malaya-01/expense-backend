import { Module } from '@nestjs/common';
import { FxController } from './fx.controller';

@Module({
  controllers: [FxController],
})
export class FxModule {}
