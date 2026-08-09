import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Response, Request as ExpressRequest } from 'express';
import { AiSettingsService } from './ai-settings.service';
import { AiAdvisorService } from './ai-advisor.service';
import {
  ArchiveConversationDto,
  BulkProposalsDto,
  ChatMessageDto,
  CreateAiMemoryDto,
  PinConversationDto,
  RenameConversationDto,
  SelectActiveProviderDto,
  SuggestCategoryIconDto,
  UpdateAiMemoryPreferenceDto,
  UpdateMasterPromptDto,
  UploadAiDocumentDto,
  UpsertProviderConfigDto,
} from './dto/ai-advisor.dto';
import { AI_PROVIDERS, AiProviderId } from './providers/types';
import { errorResponse, successResponse } from 'src/utils/response/response';
import { RequirePermissions } from 'src/helper/decorators/permissions.decorator';

@ApiBearerAuth('bearer')
@ApiTags('ai-advisor')
@RequirePermissions('ai.access')
@Controller('ai')
export class AiAdvisorController {
  constructor(
    private readonly settingsService: AiSettingsService,
    private readonly advisorService: AiAdvisorService,
  ) {}

  @Get('settings')
  @ApiOperation({ summary: 'Get AI provider settings and guides' })
  @RequirePermissions('ai.read')
  async getSettings(@Req() req: ExpressRequest, @Res() res: Response) {
    try {
      const userId = (req as any).user.id as string;
      const data = await this.settingsService.getSettings(userId);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'AI settings loaded.'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Post('providers')
  @ApiOperation({ summary: 'Save or update a provider configuration' })
  @ApiBody({ type: UpsertProviderConfigDto })
  @RequirePermissions('ai.create')
  async upsertProvider(
    @Body() dto: UpsertProviderConfigDto,
    @Req() req: ExpressRequest,
    @Res() res: Response,
  ) {
    try {
      const userId = (req as any).user.id as string;
      const data = await this.settingsService.upsertProvider(userId, dto);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Provider saved.'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Delete('providers/:provider')
  @ApiOperation({ summary: 'Disconnect a provider and wipe credentials' })
  @RequirePermissions('ai.delete')
  async disconnect(
    @Param('provider') provider: string,
    @Req() req: ExpressRequest,
    @Res() res: Response,
  ) {
    try {
      this.assertProvider(provider);
      const userId = (req as any).user.id as string;
      const data = await this.settingsService.disconnectProvider(
        userId,
        provider as AiProviderId,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Provider disconnected.'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Post('providers/:provider/test')
  @ApiOperation({ summary: 'Test provider connection' })
  @RequirePermissions('ai.create')
  async test(
    @Param('provider') provider: string,
    @Req() req: ExpressRequest,
    @Res() res: Response,
  ) {
    try {
      this.assertProvider(provider);
      const userId = (req as any).user.id as string;
      const data = await this.settingsService.testProvider(
        userId,
        provider as AiProviderId,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, data.ok ? 'Connected.' : 'Test failed.'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Get('providers/:provider/models')
  @ApiOperation({ summary: 'List models for a provider' })
  @RequirePermissions('ai.read')
  async models(
    @Param('provider') provider: string,
    @Req() req: ExpressRequest,
    @Res() res: Response,
  ) {
    try {
      this.assertProvider(provider);
      const userId = (req as any).user.id as string;
      const data = await this.settingsService.listModels(
        userId,
        provider as AiProviderId,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Models loaded.'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Post('active')
  @ApiOperation({ summary: 'Select active provider and model' })
  @RequirePermissions('ai.create')
  async selectActive(
    @Body() dto: SelectActiveProviderDto,
    @Req() req: ExpressRequest,
    @Res() res: Response,
  ) {
    try {
      const userId = (req as any).user.id as string;
      const data = await this.settingsService.selectActive(userId, dto);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Active provider updated.'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Patch('master-prompt')
  @ApiOperation({ summary: 'Update user master-prompt customization' })
  @RequirePermissions('ai.update')
  async masterPrompt(
    @Body() dto: UpdateMasterPromptDto,
    @Req() req: ExpressRequest,
    @Res() res: Response,
  ) {
    try {
      const userId = (req as any).user.id as string;
      const data = await this.settingsService.updateMasterPrompt(userId, dto);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Master prompt saved.'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Get('starters')
  @ApiOperation({ summary: 'Suggested starter questions' })
  @RequirePermissions('ai.read')
  async starters(@Req() req: ExpressRequest, @Res() res: Response) {
    try {
      const userId = (req as any).user.id as string;
      const data = await this.advisorService.starterPrompts(userId);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Starters ready.'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Get('commands')
  @ApiOperation({ summary: 'Slash (/) and mention (@) command catalog' })
  @RequirePermissions('ai.read')
  async commands(@Res() res: Response) {
    try {
      const data = this.advisorService.commandCatalog();
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Command catalog ready.'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Post('suggest-category-icon')
  @ApiOperation({
    summary: 'Suggest a category icon id from name/description (AI + fallback)',
  })
  @RequirePermissions('ai.create')
  @ApiBody({ type: SuggestCategoryIconDto })
  async suggestCategoryIcon(
    @Body() dto: SuggestCategoryIconDto,
    @Req() req: ExpressRequest,
    @Res() res: Response,
  ) {
    try {
      const data = await this.advisorService.suggestCategoryIcon(
        (req as any).user.id as string,
        dto.name,
        dto.description,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Category icon suggested.'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Get('memories')
  @RequirePermissions('ai.read')
  async memories(@Req() req: ExpressRequest, @Res() res: Response) {
    try {
      const data = await this.advisorService.listMemories(
        (req as any).user.id as string,
      );
      return res.status(HttpStatus.OK).send(successResponse(data, 'AI memories loaded.'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Post('memories')
  @RequirePermissions('ai.create')
  async addMemory(
    @Body() dto: CreateAiMemoryDto,
    @Req() req: ExpressRequest,
    @Res() res: Response,
  ) {
    try {
      const data = await this.advisorService.addMemory(
        (req as any).user.id as string,
        dto.content,
      );
      return res.status(HttpStatus.OK).send(successResponse(data, 'Memory saved.'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Patch('memories/preference')
  @RequirePermissions('ai.update')
  async memoryPreference(
    @Body() dto: UpdateAiMemoryPreferenceDto,
    @Req() req: ExpressRequest,
    @Res() res: Response,
  ) {
    try {
      const data = await this.advisorService.setMemoryEnabled(
        (req as any).user.id as string,
        dto.enabled,
      );
      return res.status(HttpStatus.OK).send(successResponse(data, 'Memory preference saved.'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Delete('memories/:id')
  @RequirePermissions('ai.delete')
  async deleteMemory(
    @Param('id') id: string,
    @Req() req: ExpressRequest,
    @Res() res: Response,
  ) {
    try {
      const data = await this.advisorService.deleteMemory(
        (req as any).user.id as string,
        id,
      );
      return res.status(HttpStatus.OK).send(successResponse(data, 'Memory deleted.'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Get('conversations')
  @RequirePermissions('ai.read')
  async conversations(
    @Req() req: ExpressRequest,
    @Res() res: Response,
    @Query('q') q?: string,
    @Query('archived') archived?: string,
  ) {
    try {
      const userId = (req as any).user.id as string;
      const data = await this.advisorService.listConversations(
        userId,
        q?.trim() || undefined,
        { archived: archived === '1' || archived === 'true' },
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Conversations loaded.'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Get('conversations/:id')
  @RequirePermissions('ai.read')
  async conversation(
    @Param('id') id: string,
    @Req() req: ExpressRequest,
    @Res() res: Response,
  ) {
    try {
      const userId = (req as any).user.id as string;
      const data = await this.advisorService.getConversation(userId, id);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Conversation loaded.'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Patch('conversations/:id')
  @ApiOperation({ summary: 'Rename a conversation' })
  @RequirePermissions('ai.update')
  async renameConversation(
    @Param('id') id: string,
    @Body() dto: RenameConversationDto,
    @Req() req: ExpressRequest,
    @Res() res: Response,
  ) {
    try {
      const data = await this.advisorService.renameConversation(
        (req as any).user.id as string,
        id,
        dto.title,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Conversation renamed.'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Post('conversations/:id/pin')
  @ApiOperation({ summary: 'Pin or unpin a conversation' })
  @RequirePermissions('ai.create')
  async pinConversation(
    @Param('id') id: string,
    @Body() dto: PinConversationDto,
    @Req() req: ExpressRequest,
    @Res() res: Response,
  ) {
    try {
      const data = await this.advisorService.pinConversation(
        (req as any).user.id as string,
        id,
        dto.pinned,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, dto.pinned ? 'Pinned.' : 'Unpinned.'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Post('conversations/:id/duplicate')
  @ApiOperation({ summary: 'Duplicate a conversation' })
  @RequirePermissions('ai.create')
  async duplicateConversation(
    @Param('id') id: string,
    @Req() req: ExpressRequest,
    @Res() res: Response,
  ) {
    try {
      const data = await this.advisorService.duplicateConversation(
        (req as any).user.id as string,
        id,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Conversation duplicated.'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Post('conversations/:id/archive')
  @ApiOperation({ summary: 'Archive or restore a conversation' })
  @RequirePermissions('ai.create')
  async archiveConversation(
    @Param('id') id: string,
    @Body() dto: ArchiveConversationDto,
    @Req() req: ExpressRequest,
    @Res() res: Response,
  ) {
    try {
      const data = await this.advisorService.archiveConversation(
        (req as any).user.id as string,
        id,
        dto.archived,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, dto.archived ? 'Archived.' : 'Restored.'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Delete('conversations/:id')
  @RequirePermissions('ai.delete')
  async deleteConversation(
    @Param('id') id: string,
    @Req() req: ExpressRequest,
    @Res() res: Response,
  ) {
    try {
      const userId = (req as any).user.id as string;
      const data = await this.advisorService.deleteConversation(userId, id);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Conversation deleted.'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Get('proposals/pending')
  @ApiOperation({ summary: 'List pending action proposals across conversations' })
  @RequirePermissions('ai.read')
  async pendingProposals(@Req() req: ExpressRequest, @Res() res: Response) {
    try {
      const data = await this.advisorService.listPendingProposals(
        (req as any).user.id as string,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Pending actions loaded.'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Get('documents')
  @ApiOperation({ summary: 'List recent AI documents' })
  @RequirePermissions('ai.read')
  async listDocuments(@Req() req: ExpressRequest, @Res() res: Response) {
    try {
      const data = await this.advisorService.listDocuments(
        (req as any).user.id as string,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Documents loaded.'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Get('documents/:id')
  @ApiOperation({ summary: 'Get document metadata and analysis' })
  @RequirePermissions('ai.read')
  async getDocument(
    @Param('id') id: string,
    @Req() req: ExpressRequest,
    @Res() res: Response,
  ) {
    try {
      const data = await this.advisorService.getDocument(
        (req as any).user.id as string,
        id,
        false,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Document loaded.'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Post('documents')
  @ApiOperation({ summary: 'Upload a document into the AI library' })
  @ApiBody({ type: UploadAiDocumentDto })
  @RequirePermissions('ai.create')
  async uploadDocument(
    @Body() dto: UploadAiDocumentDto,
    @Req() req: ExpressRequest,
    @Res() res: Response,
  ) {
    try {
      const data = await this.advisorService.uploadDocument(
        (req as any).user.id as string,
        dto,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Document uploaded.'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Delete('documents/:id')
  @ApiOperation({ summary: 'Soft-delete an AI document' })
  @RequirePermissions('ai.delete')
  async deleteDocument(
    @Param('id') id: string,
    @Req() req: ExpressRequest,
    @Res() res: Response,
  ) {
    try {
      const data = await this.advisorService.deleteDocument(
        (req as any).user.id as string,
        id,
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Document deleted.'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Post('chat')
  @ApiOperation({ summary: 'Send a message to FinOS AI Advisor' })
  @ApiBody({ type: ChatMessageDto })
  @RequirePermissions('ai.create')
  async chat(
    @Body() dto: ChatMessageDto,
    @Req() req: ExpressRequest,
    @Res() res: Response,
  ) {
    try {
      const userId = (req as any).user.id as string;
      const data = await this.advisorService.chat(userId, dto);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Advisor replied.'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Post('chat/stream')
  @ApiOperation({ summary: 'Stream a FinOS AI Advisor reply (SSE)' })
  @ApiBody({ type: ChatMessageDto })
  @RequirePermissions('ai.create')
  async chatStream(
    @Body() dto: ChatMessageDto,
    @Req() req: ExpressRequest,
    @Res() res: Response,
  ) {
    const userId = (req as any).user.id as string;
    const ac = new AbortController();
    req.on('aborted', () => ac.abort());
    res.on('close', () => {
      if (!res.writableEnded) ac.abort();
    });

    res.status(HttpStatus.OK);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Content-Encoding', 'identity');
    res.socket?.setNoDelay(true);
    res.socket?.setKeepAlive(true);
    if (typeof (res as any).flushHeaders === 'function') {
      (res as any).flushHeaders();
    }
    res.write(': connected\n\n');

    try {
      for await (const event of this.advisorService.chatStream(
        userId,
        dto,
        ac.signal,
      )) {
        if (ac.signal.aborted || res.writableEnded) break;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (typeof (res as any).flush === 'function') {
          (res as any).flush();
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } catch (error: any) {
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            type: 'error',
            message: error?.message || 'Stream failed',
          })}\n\n`,
        );
      }
    } finally {
      if (!res.writableEnded) {
        res.write('data: {"type":"close"}\n\n');
        res.end();
      }
    }
  }

  @Post('proposals/bulk')
  @ApiOperation({
    summary: 'Confirm and/or reject many proposals in one request',
  })
  @RequirePermissions('ai.create')
  @ApiBody({ type: BulkProposalsDto })
  async bulkProposals(
    @Body() dto: BulkProposalsDto,
    @Req() req: ExpressRequest,
    @Res() res: Response,
  ) {
    try {
      const userId = (req as any).user.id as string;
      const data = await this.advisorService.bulkDecideProposals(
        userId,
        dto.confirm_ids || [],
        dto.reject_ids || [],
      );
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Bulk proposal decision applied.'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Post('proposals/:id/confirm')
  @ApiOperation({ summary: 'Confirm and execute a proposed action' })
  @RequirePermissions('ai.create')
  async confirm(
    @Param('id') id: string,
    @Req() req: ExpressRequest,
    @Res() res: Response,
  ) {
    try {
      const userId = (req as any).user.id as string;
      const data = await this.advisorService.confirmProposal(userId, id);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Action confirmed.'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  @Post('proposals/:id/reject')
  @ApiOperation({ summary: 'Reject a proposed action' })
  @RequirePermissions('ai.create')
  async reject(
    @Param('id') id: string,
    @Req() req: ExpressRequest,
    @Res() res: Response,
  ) {
    try {
      const userId = (req as any).user.id as string;
      const data = await this.advisorService.rejectProposal(userId, id);
      return res
        .status(HttpStatus.OK)
        .send(successResponse(data, 'Action rejected.'));
    } catch (error) {
      return this.fail(res, error);
    }
  }

  private assertProvider(provider: string) {
    if (!(AI_PROVIDERS as readonly string[]).includes(provider)) {
      throw new Error('Unsupported provider');
    }
  }

  private fail(res: Response, error: any) {
    const message = error.message || 'An unexpected error occured';
    const statusCode =
      error.statuscode || error.status || HttpStatus.BAD_REQUEST;
    return res.status(statusCode).send(errorResponse(message, statusCode, []));
  }
}
