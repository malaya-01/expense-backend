import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { SpacesService } from './spaces.service';
import {
  ContributeSpaceGoalDto,
  CreateSettlementDto,
  CreateSpaceBudgetDto,
  CreateSpaceDto,
  CreateSpaceExpenseDto,
  CreateSpaceGoalDto,
  FavoriteSpaceDto,
  InviteMemberDto,
  SyncOutboxDto,
  UpdateMemberRoleDto,
  UpdateSpaceDto,
  WalletMovementDto,
} from './dto/spaces.dto';
import { errorResponse, successResponse } from 'src/utils/response/response';
import { RequirePermissions } from 'src/helper/decorators/permissions.decorator';

@RequirePermissions('spaces.access')
@ApiBearerAuth('bearer')
@ApiTags('spaces')
@Controller('spaces')
export class SpacesController {
  constructor(private readonly spacesService: SpacesService) {}

  private userId(req: Request) {
    return (req as any).user.id as string;
  }

  private fail(res: Response, error: any) {
    const statusCode = error.status || error.statusCode || HttpStatus.BAD_REQUEST;
    return res
      .status(statusCode)
      .send(errorResponse(error.message || 'Request failed', statusCode));
  }

  @Get()
  @ApiOperation({ summary: 'List my collaborative spaces' })
  @RequirePermissions('spaces.read')
  async listMine(@Req() req: Request, @Res() res: Response) {
    try {
      const data = await this.spacesService.listMine(this.userId(req));
      return res.status(HttpStatus.OK).send(successResponse(data, 'Spaces loaded'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Post()
  @RequirePermissions('spaces.create')
  async create(
    @Req() req: Request,
    @Body() dto: CreateSpaceDto,
    @Res() res: Response,
  ) {
    try {
      const data = await this.spacesService.create(this.userId(req), dto);
      return res.status(HttpStatus.OK).send(successResponse(data, 'Space created'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Get('notifications')
  @RequirePermissions('spaces.read')
  async notifications(@Req() req: Request, @Res() res: Response) {
    try {
      const data = await this.spacesService.listNotifications(this.userId(req));
      return res.status(HttpStatus.OK).send(successResponse(data, 'Notifications'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Patch('notifications/read')
  @RequirePermissions('spaces.read')
  async markNotificationsRead(
    @Req() req: Request,
    @Body() body: { ids?: string[] },
    @Res() res: Response,
  ) {
    try {
      const data = await this.spacesService.markNotificationsRead(
        this.userId(req),
        body.ids || [],
      );
      return res.status(HttpStatus.OK).send(successResponse(data, 'Marked read'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Get('sync/outbox')
  @RequirePermissions('spaces.read')
  async syncOutbox(@Req() req: Request, @Res() res: Response) {
    try {
      const data = await this.spacesService.listSyncOutbox(this.userId(req));
      return res.status(HttpStatus.OK).send(successResponse(data, 'Outbox'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Post('sync/outbox')
  @RequirePermissions('spaces.create')
  async enqueueSync(
    @Req() req: Request,
    @Body() dto: SyncOutboxDto,
    @Res() res: Response,
  ) {
    try {
      const data = await this.spacesService.enqueueSync(this.userId(req), dto);
      return res.status(HttpStatus.OK).send(successResponse(data, 'Queued'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Post('sync/ack')
  @RequirePermissions('spaces.create')
  async ackSync(
    @Req() req: Request,
    @Body() body: { ids: string[] },
    @Res() res: Response,
  ) {
    try {
      const data = await this.spacesService.markSynced(
        this.userId(req),
        body.ids || [],
      );
      return res.status(HttpStatus.OK).send(successResponse(data, 'Acked'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Post('invites/:token/accept')
  @RequirePermissions('spaces.create')
  async acceptInvite(
    @Req() req: Request,
    @Param('token') token: string,
    @Res() res: Response,
  ) {
    try {
      const data = await this.spacesService.acceptInvite(this.userId(req), token);
      return res.status(HttpStatus.OK).send(successResponse(data, 'Joined space'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Get(':spaceId')
  @RequirePermissions('spaces.read')
  async dashboard(
    @Req() req: Request,
    @Param('spaceId') spaceId: string,
    @Res() res: Response,
  ) {
    try {
      const data = await this.spacesService.getDashboard(this.userId(req), spaceId);
      return res.status(HttpStatus.OK).send(successResponse(data, 'Dashboard'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Patch(':spaceId')
  @RequirePermissions('spaces.update')
  async update(
    @Req() req: Request,
    @Param('spaceId') spaceId: string,
    @Body() dto: UpdateSpaceDto,
    @Res() res: Response,
  ) {
    try {
      const data = await this.spacesService.updateSpace(
        this.userId(req),
        spaceId,
        dto,
      );
      return res.status(HttpStatus.OK).send(successResponse(data, 'Updated'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Post(':spaceId/favorite')
  @RequirePermissions('spaces.update')
  async favorite(
    @Req() req: Request,
    @Param('spaceId') spaceId: string,
    @Body() dto: FavoriteSpaceDto,
    @Res() res: Response,
  ) {
    try {
      const data = await this.spacesService.setFavorite(
        this.userId(req),
        spaceId,
        dto.favorite,
        dto.position,
      );
      return res.status(HttpStatus.OK).send(successResponse(data, 'Favorite saved'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Get(':spaceId/members')
  @RequirePermissions('spaces.read')
  async members(
    @Req() req: Request,
    @Param('spaceId') spaceId: string,
    @Res() res: Response,
  ) {
    try {
      await this.spacesService.getDashboard(this.userId(req), spaceId);
      const data = await this.spacesService.listMembers(spaceId);
      return res.status(HttpStatus.OK).send(successResponse(data, 'Members'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Post(':spaceId/invites')
  @RequirePermissions('spaces.create')
  async invite(
    @Req() req: Request,
    @Param('spaceId') spaceId: string,
    @Body() dto: InviteMemberDto,
    @Res() res: Response,
  ) {
    try {
      const data = await this.spacesService.invite(
        this.userId(req),
        spaceId,
        dto,
      );
      return res.status(HttpStatus.OK).send(successResponse(data, 'Invite sent'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Patch(':spaceId/members/:memberId')
  @RequirePermissions('spaces.update')
  async updateRole(
    @Req() req: Request,
    @Param('spaceId') spaceId: string,
    @Param('memberId') memberId: string,
    @Body() dto: UpdateMemberRoleDto,
    @Res() res: Response,
  ) {
    try {
      const data = await this.spacesService.updateMemberRole(
        this.userId(req),
        spaceId,
        memberId,
        dto.role,
      );
      return res.status(HttpStatus.OK).send(successResponse(data, 'Role updated'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Delete(':spaceId/members/:memberId')
  @RequirePermissions('spaces.delete')
  async removeMember(
    @Req() req: Request,
    @Param('spaceId') spaceId: string,
    @Param('memberId') memberId: string,
    @Res() res: Response,
  ) {
    try {
      const data = await this.spacesService.removeMember(
        this.userId(req),
        spaceId,
        memberId,
      );
      return res.status(HttpStatus.OK).send(successResponse(data, 'Member removed'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Get(':spaceId/expenses')
  @RequirePermissions('spaces.read')
  async expenses(
    @Req() req: Request,
    @Param('spaceId') spaceId: string,
    @Res() res: Response,
  ) {
    try {
      await this.spacesService.getDashboard(this.userId(req), spaceId);
      const data = await this.spacesService.listExpenses(spaceId);
      return res.status(HttpStatus.OK).send(successResponse(data, 'Expenses'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Post(':spaceId/expenses')
  @RequirePermissions('spaces.create')
  async createExpense(
    @Req() req: Request,
    @Param('spaceId') spaceId: string,
    @Body() dto: CreateSpaceExpenseDto,
    @Res() res: Response,
  ) {
    try {
      const data = await this.spacesService.createExpense(
        this.userId(req),
        spaceId,
        dto,
      );
      return res.status(HttpStatus.OK).send(successResponse(data, 'Expense created'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Get(':spaceId/balances')
  @RequirePermissions('spaces.read')
  async balances(
    @Req() req: Request,
    @Param('spaceId') spaceId: string,
    @Res() res: Response,
  ) {
    try {
      await this.spacesService.assertReadable(this.userId(req), spaceId);
      const data = await this.spacesService.computeBalances(spaceId);
      return res.status(HttpStatus.OK).send(successResponse(data, 'Balances'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Get(':spaceId/settlements')
  @RequirePermissions('spaces.read')
  async settlements(
    @Req() req: Request,
    @Param('spaceId') spaceId: string,
    @Res() res: Response,
  ) {
    try {
      await this.spacesService.getDashboard(this.userId(req), spaceId);
      const data = await this.spacesService.listSettlements(spaceId);
      return res.status(HttpStatus.OK).send(successResponse(data, 'Settlements'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Post(':spaceId/settlements')
  @RequirePermissions('spaces.create')
  async createSettlement(
    @Req() req: Request,
    @Param('spaceId') spaceId: string,
    @Body() dto: CreateSettlementDto,
    @Res() res: Response,
  ) {
    try {
      const data = await this.spacesService.createSettlement(
        this.userId(req),
        spaceId,
        dto,
      );
      return res.status(HttpStatus.OK).send(successResponse(data, 'Settlement saved'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Get(':spaceId/budgets')
  @RequirePermissions('spaces.read')
  async budgets(
    @Req() req: Request,
    @Param('spaceId') spaceId: string,
    @Res() res: Response,
  ) {
    try {
      await this.spacesService.getDashboard(this.userId(req), spaceId);
      const data = await this.spacesService.listBudgets(spaceId);
      return res.status(HttpStatus.OK).send(successResponse(data, 'Budgets'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Post(':spaceId/budgets')
  @RequirePermissions('spaces.create')
  async createBudget(
    @Req() req: Request,
    @Param('spaceId') spaceId: string,
    @Body() dto: CreateSpaceBudgetDto,
    @Res() res: Response,
  ) {
    try {
      const data = await this.spacesService.createBudget(
        this.userId(req),
        spaceId,
        dto,
      );
      return res.status(HttpStatus.OK).send(successResponse(data, 'Budget created'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Get(':spaceId/goals')
  @RequirePermissions('spaces.read')
  async goals(
    @Req() req: Request,
    @Param('spaceId') spaceId: string,
    @Res() res: Response,
  ) {
    try {
      await this.spacesService.getDashboard(this.userId(req), spaceId);
      const data = await this.spacesService.listGoals(spaceId);
      return res.status(HttpStatus.OK).send(successResponse(data, 'Goals'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Post(':spaceId/goals')
  @RequirePermissions('spaces.create')
  async createGoal(
    @Req() req: Request,
    @Param('spaceId') spaceId: string,
    @Body() dto: CreateSpaceGoalDto,
    @Res() res: Response,
  ) {
    try {
      const data = await this.spacesService.createGoal(
        this.userId(req),
        spaceId,
        dto,
      );
      return res.status(HttpStatus.OK).send(successResponse(data, 'Goal created'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Post(':spaceId/goals/:goalId/contribute')
  @RequirePermissions('spaces.create')
  async contribute(
    @Req() req: Request,
    @Param('spaceId') spaceId: string,
    @Param('goalId') goalId: string,
    @Body() dto: ContributeSpaceGoalDto,
    @Res() res: Response,
  ) {
    try {
      const data = await this.spacesService.contributeGoal(
        this.userId(req),
        spaceId,
        goalId,
        dto,
      );
      return res.status(HttpStatus.OK).send(successResponse(data, 'Contribution saved'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Get(':spaceId/activity')
  @RequirePermissions('spaces.read')
  async activity(
    @Req() req: Request,
    @Param('spaceId') spaceId: string,
    @Res() res: Response,
  ) {
    try {
      await this.spacesService.getDashboard(this.userId(req), spaceId);
      const data = await this.spacesService.listActivity(spaceId);
      return res.status(HttpStatus.OK).send(successResponse(data, 'Activity'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Post(':spaceId/wallet')
  @RequirePermissions('spaces.create')
  async wallet(
    @Req() req: Request,
    @Param('spaceId') spaceId: string,
    @Body() dto: WalletMovementDto,
    @Res() res: Response,
  ) {
    try {
      const data = await this.spacesService.walletMove(
        this.userId(req),
        spaceId,
        dto,
      );
      return res.status(HttpStatus.OK).send(successResponse(data, 'Wallet updated'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Get(':spaceId/reports')
  @RequirePermissions('spaces.read')
  async reports(
    @Req() req: Request,
    @Param('spaceId') spaceId: string,
    @Res() res: Response,
  ) {
    try {
      const data = await this.spacesService.reports(this.userId(req), spaceId);
      return res.status(HttpStatus.OK).send(successResponse(data, 'Reports'));
    } catch (error) {
      return this.fail(res, error);
    }
  }
}
