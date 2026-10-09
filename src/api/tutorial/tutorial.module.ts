import { Module } from '@nestjs/common';
import { TutorialController } from './tutorial.controller';
import { TutorialService } from './tutorial.service';

@Module({
  controllers: [TutorialController],
  providers: [TutorialService],
})
export class TutorialModule {}
