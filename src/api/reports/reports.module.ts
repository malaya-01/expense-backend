import { Module, forwardRef } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';
import { ReportDispatchService } from './report-dispatch.service';
import { AiAdvisorModule } from '../ai-advisor/ai-advisor.module';

@Module({
  imports: [forwardRef(() => AiAdvisorModule)],
  controllers: [ReportsController],
  providers: [ReportsService, ReportDispatchService],
  exports: [ReportsService, ReportDispatchService],
})
export class ReportsModule {}
