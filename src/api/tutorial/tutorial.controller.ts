import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { TutorialService } from './tutorial.service';
import { TutorialProgressDto } from './dto/tutorial.dto';
import { errorResponse, successResponse } from 'src/utils/response/response';
import { RequirePermissions } from 'src/helper/decorators/permissions.decorator';

@RequirePermissions('dashboard.access')
@ApiBearerAuth('bearer')
@Controller('tutorial')
export class TutorialController {
  constructor(private readonly tutorialService: TutorialService) {}

  @Get()
  @ApiOperation({
    summary: 'Get the guided tutorial (steps + this user progress)',
  })
  async getTutorial(@Req() req: Request, @Res() res: Response) {
    try {
      const data = await this.tutorialService.getTutorial(
        (req as any).user.id as string,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Tutorial'));
    } catch (error) {
      const statusCode = error.status || error.statusCode || HttpStatus.BAD_REQUEST;
      return res
        .status(statusCode)
        .send(errorResponse(error.message || 'Failed to load tutorial', statusCode));
    }
  }

  @Patch('progress')
  @ApiOperation({ summary: 'Record a step view, a skip, or completion' })
  async recordProgress(
    @Req() req: Request,
    @Body() dto: TutorialProgressDto,
    @Res() res: Response,
  ) {
    try {
      const data = await this.tutorialService.recordProgress(
        (req as any).user.id as string,
        dto,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Tutorial progress saved'));
    } catch (error) {
      const statusCode = error.status || error.statusCode || HttpStatus.BAD_REQUEST;
      return res
        .status(statusCode)
        .send(errorResponse(error.message || 'Failed to save tutorial progress', statusCode));
    }
  }

  @Post('restart')
  @ApiOperation({ summary: 'Replay the tutorial from the first step' })
  async restart(@Req() req: Request, @Res() res: Response) {
    try {
      const data = await this.tutorialService.restart(
        (req as any).user.id as string,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Tutorial restarted'));
    } catch (error) {
      const statusCode = error.status || error.statusCode || HttpStatus.BAD_REQUEST;
      return res
        .status(statusCode)
        .send(errorResponse(error.message || 'Failed to restart tutorial', statusCode));
    }
  }
}
