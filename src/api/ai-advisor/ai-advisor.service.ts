import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { ObjectStorageService } from 'src/storage/object-storage.service';
import { AiSettingsService } from './ai-settings.service';
import { AiOmnirouteUsageService } from './ai-omniroute-usage.service';
import { AiToolsService, Citation } from './ai-tools.service';
import { AiWebSearchService } from './ai-web-search.service';
import { runProviderChat, runProviderChatStream } from './providers';
import { omnirouteAdapter } from './providers/omniroute.adapter';
import { isOmnirouteProvider } from './providers/omniroute.free-backends';
import { buildSystemPrompt } from './prompts/finos-master';
import { ChatMessageDto } from './dto/ai-advisor.dto';
import { ChatMessage } from './providers/types';
import {
  AI_AT_TOOLS,
  AI_SLASH_COMMANDS,
  SUPPORTED_ACTION_TYPES,
  parseAtMentions,
  parseSlashCommand,
} from './ai-command-catalog';
import {
  buildSeedCategoryProposals,
  wantsCategorySeed,
} from './default-category-taxonomy';
import { MAX_CONTINUATIONS } from './providers/continuation';
import { sanitizeAssistantMarkdown } from './markdown-sanitizer';
import {
  ProposalContext,
  repairReferenceIds,
  validateTransactionProposal,
} from './transaction-proposal';
import { fitJsonToBudget, fitStringList } from './context-budget';

/** Normalised stop reason surfaced to the client on `done`. */
export type AdvisorFinishReason = 'stop' | 'length' | 'refusal' | 'error';

type ReplyMeta = {
  truncated: boolean;
  finish_reason: AdvisorFinishReason;
  continuations: number;
};

const TRANSACTION_PROPOSALS = new Set([
  'create_transaction',
  'update_transaction',
  'create_recurring',
  'update_recurring',
]);

const REFERENCE_PROPOSALS = new Set([
  'create_budget',
  'update_budget',
  'create_goal',
  'create_holding',
  'create_loan',
  'update_loan',
  'create_space_expense',
  'propose_settlement',
]);

function extractAdvisorErrorMessage(error: unknown): string {
  if (!error) return 'Advisor stream failed';
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'string' && response.trim()) return response.trim();
    if (response && typeof response === 'object') {
      const message = (response as { message?: string | string[] }).message;
      if (Array.isArray(message)) {
        const joined = message.filter(Boolean).join(', ').trim();
        if (joined) return joined;
      } else if (typeof message === 'string' && message.trim()) {
        return message.trim();
      }
    }
  }
  if (error instanceof Error && error.message.trim()) {
    // Nest often sets Error.message to "Http Exception" — prefer getResponse above.
    if (!/^http exception$/i.test(error.message.trim())) {
      return error.message.trim();
    }
  }
  return 'Advisor stream failed';
}

import {
  CATEGORY_ICON_IDS,
  suggestCategoryIconHeuristic,
} from '../categories/category-icons';

export type AiChatStreamEvent =
  | { type: 'status'; message: string }
  | {
      type: 'meta';
      conversation_id: string;
      provider: string;
      model: string;
    }
  | { type: 'delta'; text: string }
  | {
      type: 'context';
      tool_activity: Array<{ name: string; status: string; summary: string }>;
      citations: Citation[];
    }
  | {
      type: 'done';
      conversation_id: string;
      conversation_title?: string | null;
      message: Record<string, unknown>;
      proposals: any[];
      provider: string;
      model: string;
      tool_activity: Array<{ name: string; status: string; summary: string }>;
      citations: Citation[];
      suggested_questions: string[];
      /** True only if the reply is still cut after auto-continuation. */
      truncated: boolean;
      finish_reason: AdvisorFinishReason;
      /** Continuation requests stitched into the reply (0 = none needed). */
      continuations: number;
      /** Saved text differs from the streamed deltas (mermaid / fence fixes). */
      content_sanitized: boolean;
    }
  | { type: 'error'; message: string };

type ParsedProposal = {
  action_type: string;
  title: string;
  summary?: string;
  payload: Record<string, unknown>;
};

@Injectable()
export class AiAdvisorService {
  private readonly documentLogger = new Logger('AiAdvisorDocuments');

  constructor(
    @Inject('PG_POOL')
    private readonly pgPool: Pool,
    private readonly settingsService: AiSettingsService,
    private readonly toolsService: AiToolsService,
    private readonly webSearchService: AiWebSearchService,
    private readonly omnirouteUsage: AiOmnirouteUsageService,
    private readonly storage: ObjectStorageService,
  ) {}

  async listConversations(
    userId: string,
    query?: string,
    options?: { archived?: boolean },
  ) {
    const search = query?.trim();
    const archived = Boolean(options?.archived);
    const result = await this.pgPool.query(
      `SELECT id, title, provider, model, pinned_at, archived_at, auto_titled_at,
              last_message_preview, created_at, updated_at
       FROM ai_conversations
       WHERE user_id = $1
         AND deleted_at IS NULL
         AND (
           ($3::boolean IS TRUE AND archived_at IS NOT NULL)
           OR ($3::boolean IS NOT TRUE AND archived_at IS NULL)
         )
         AND (
           $2::text IS NULL
           OR title ILIKE '%' || $2 || '%'
           OR COALESCE(last_message_preview, '') ILIKE '%' || $2 || '%'
         )
       ORDER BY pinned_at DESC NULLS LAST, updated_at DESC
       LIMIT 80`,
      [userId, search || null, archived],
    );
    return result.rows;
  }

  async getConversation(userId: string, id: string) {
    const conv = await this.pgPool.query(
      `SELECT id, title, provider, model, pinned_at, archived_at, last_message_preview,
              created_at, updated_at
       FROM ai_conversations
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [id, userId],
    );
    if (!conv.rowCount) throw new NotFoundException('Conversation not found');
    const messages = await this.pgPool.query(
      `SELECT id, role, content, attachments, tool_activity, citations, proposal_ids, provider, model, created_at
       FROM ai_messages
       WHERE conversation_id = $1 AND user_id = $2
       ORDER BY created_at ASC`,
      [id, userId],
    );
    const proposalIds = messages.rows.flatMap(
      (m) => (Array.isArray(m.proposal_ids) ? m.proposal_ids : []),
    );
    let proposals: any[] = [];
    if (proposalIds.length) {
      const props = await this.pgPool.query(
        `SELECT id, action_type, title, summary, payload, status, expires_at, result, created_at
         FROM ai_action_proposals
         WHERE user_id = $1 AND id = ANY($2::uuid[])`,
        [userId, proposalIds],
      );
      proposals = props.rows;
    }
    return {
      conversation: conv.rows[0],
      messages: messages.rows,
      proposals,
    };
  }

  async deleteConversation(userId: string, id: string) {
    const result = await this.pgPool.query(
      `UPDATE ai_conversations
       SET deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING id`,
      [id, userId],
    );
    if (!result.rowCount) throw new NotFoundException('Conversation not found');
    // Documents uploaded into this conversation go with it.
    const documents = await this.pgPool.query(
      `UPDATE ai_documents
       SET deleted_at = NOW(), updated_at = NOW(), content = NULL
       WHERE conversation_id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING stored_file_id`,
      [id, userId],
    );
    this.releaseDocumentFiles(userId, documents.rows);
    return { id };
  }

  async renameConversation(userId: string, id: string, title: string) {
    const result = await this.pgPool.query(
      `UPDATE ai_conversations
       SET title = $3,
           auto_titled_at = COALESCE(auto_titled_at, NOW()),
           updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING id, title, provider, model, pinned_at, archived_at, auto_titled_at,
                 last_message_preview, created_at, updated_at`,
      [id, userId, title.trim().slice(0, 80)],
    );
    if (!result.rowCount) throw new NotFoundException('Conversation not found');
    return result.rows[0];
  }

  async pinConversation(userId: string, id: string, pinned: boolean) {
    const result = await this.pgPool.query(
      `UPDATE ai_conversations
       SET pinned_at = CASE WHEN $3 THEN COALESCE(pinned_at, NOW()) ELSE NULL END,
           updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING id, title, provider, model, pinned_at, archived_at, last_message_preview,
                 created_at, updated_at`,
      [id, userId, pinned],
    );
    if (!result.rowCount) throw new NotFoundException('Conversation not found');
    return result.rows[0];
  }

  async duplicateConversation(userId: string, id: string) {
    const source = await this.getConversation(userId, id);
    const title = `${source.conversation.title} (copy)`.slice(0, 200);
    const created = await this.pgPool.query(
      `INSERT INTO ai_conversations
        (user_id, title, provider, model, last_message_preview, auto_titled_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING id, title, provider, model, pinned_at, last_message_preview,
                 created_at, updated_at`,
      [
        userId,
        title,
        source.conversation.provider,
        source.conversation.model,
        source.conversation.last_message_preview || null,
      ],
    );
    const newId = created.rows[0].id as string;
    for (const message of source.messages) {
      await this.pgPool.query(
        `INSERT INTO ai_messages
          (conversation_id, user_id, role, content, attachments, tool_activity,
           citations, proposal_ids, provider, model)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          newId,
          userId,
          message.role,
          message.content,
          JSON.stringify(message.attachments || []),
          JSON.stringify(message.tool_activity || []),
          JSON.stringify(message.citations || []),
          JSON.stringify([]),
          message.provider || null,
          message.model || null,
        ],
      );
    }
    return created.rows[0];
  }

  async archiveConversation(userId: string, id: string, archived: boolean) {
    const result = await this.pgPool.query(
      `UPDATE ai_conversations
       SET archived_at = CASE WHEN $3 THEN NOW() ELSE NULL END,
           pinned_at = CASE WHEN $3 THEN NULL ELSE pinned_at END,
           updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING id, archived_at`,
      [id, userId, archived],
    );
    if (!result.rowCount) throw new NotFoundException('Conversation not found');
    return result.rows[0];
  }

  async listPendingProposals(userId: string) {
    await this.pgPool.query(
      `UPDATE ai_action_proposals
       SET status = 'expired', updated_at = NOW()
       WHERE user_id = $1 AND status = 'pending' AND expires_at < NOW()`,
      [userId],
    );
    const result = await this.pgPool.query(
      `SELECT id, conversation_id, action_type, title, summary, payload, status,
              expires_at, result, created_at
       FROM ai_action_proposals
       WHERE user_id = $1 AND status = 'pending'
       ORDER BY created_at DESC
       LIMIT 40`,
      [userId],
    );
    return result.rows;
  }

  async listDocuments(userId: string) {
    const result = await this.pgPool.query(
      `SELECT id, conversation_id, name, mime_type, size_bytes, detected_type,
              summary, analysis_confidence, extracted_sections, suggested_actions,
              related_accounts, related_transactions,
              status, analysis_error, created_at, updated_at
       FROM ai_documents
       WHERE user_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 40`,
      [userId],
    );
    return result.rows;
  }

  async getDocument(userId: string, id: string, includeContent = false) {
    const result = await this.pgPool.query(
      `SELECT id, conversation_id, name, mime_type, size_bytes, detected_type,
              summary, analysis_confidence, extracted_sections, suggested_actions,
              related_accounts, related_transactions,
              status, analysis_error, created_at, updated_at
              ${includeContent ? ', content, stored_file_id' : ''}
       FROM ai_documents
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [id, userId],
    );
    if (!result.rowCount) throw new NotFoundException('Document not found');
    const row = result.rows[0];
    if (includeContent) {
      const bytes = await this.readDocumentBytes(userId, row);
      if (bytes) row.data_base64 = bytes.toString('base64');
      delete row.content;
      delete row.stored_file_id;
    }
    return row;
  }

  /** Document bytes: inline (legacy / fallback) or from R2, owner-checked. */
  private async readDocumentBytes(
    userId: string,
    row: { content?: Buffer | null; stored_file_id?: string | null },
  ): Promise<Buffer | null> {
    if (row.content) return Buffer.from(row.content);
    if (!row.stored_file_id) return null;
    try {
      const file = await this.storage.readFileBuffer(row.stored_file_id, userId);
      return file?.body || null;
    } catch (error) {
      this.documentLogger.warn(
        `Document file ${row.stored_file_id} unreadable: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  /**
   * Store an uploaded document in R2 under
   * users/{userId}/documents/{YYYY}/{MM}/{slug}-{id}.{ext}. Returns null when
   * R2 is not configured / unavailable so the caller keeps the bytes inline.
   * Invalid files (type / content mismatch) are rejected.
   */
  private async storeDocumentFile(
    userId: string,
    dto: { name: string; mime_type: string },
    buffer: Buffer,
  ): Promise<string | null> {
    if (!(await this.storage.isConfigured())) return null;
    try {
      const saved = await this.storage.saveFile({
        userId,
        kind: 'document',
        body: buffer,
        mimeType: dto.mime_type,
        filename: dto.name,
        label: dto.name.replace(/\.[a-z0-9]{1,8}$/i, ''),
      });
      return saved.id;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.documentLogger.warn(
        `Document kept in Postgres (R2 unavailable): ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  /** Best-effort release of R2 objects behind deleted documents. */
  private releaseDocumentFiles(
    userId: string,
    rows: Array<{ stored_file_id?: string | null }>,
  ) {
    for (const row of rows) {
      if (row.stored_file_id) {
        void this.storage.deleteFileById(row.stored_file_id, userId);
      }
    }
  }

  async uploadDocument(
    userId: string,
    dto: {
      name: string;
      mime_type: string;
      data_base64: string;
      conversation_id?: string;
    },
  ) {
    let buffer: Buffer;
    try {
      buffer = Buffer.from(dto.data_base64, 'base64');
    } catch {
      throw new BadRequestException('Invalid document payload');
    }
    if (!buffer.length) throw new BadRequestException('Empty document');
    if (buffer.length > 5 * 1024 * 1024) {
      throw new BadRequestException('Document must be 5 MB or smaller');
    }

    if (dto.conversation_id) {
      const existing = await this.pgPool.query(
        `SELECT id FROM ai_conversations
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [dto.conversation_id, userId],
      );
      if (!existing.rowCount) {
        throw new NotFoundException('Conversation not found');
      }
    }

    const localAnalysis = this.analyzeDocumentLocally(
      dto.name,
      dto.mime_type,
      buffer,
    );

    // Bytes go to R2; Postgres keeps them only when R2 is not configured.
    const storedFileId = await this.storeDocumentFile(userId, dto, buffer);

    // Persist immediately so upload HTTP progress matches "file received".
    // Heavy provider analysis continues in the background.
    let inserted;
    try {
      inserted = await this.pgPool.query(
        `INSERT INTO ai_documents
          (user_id, conversation_id, name, mime_type, size_bytes, content,
           detected_type, summary, analysis_confidence, extracted_sections,
           suggested_actions, related_accounts, related_transactions, status,
           stored_file_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'analyzing', $14)
         RETURNING id, conversation_id, name, mime_type, size_bytes, detected_type,
                   summary, analysis_confidence, extracted_sections, suggested_actions,
                   related_accounts, related_transactions,
                   status, analysis_error, created_at, updated_at`,
        [
          userId,
          dto.conversation_id || null,
          dto.name.trim().slice(0, 180),
          dto.mime_type,
          buffer.length,
          storedFileId ? null : buffer,
          localAnalysis.detected_type,
          localAnalysis.summary,
          localAnalysis.analysis_confidence,
          JSON.stringify(localAnalysis.extracted_sections),
          JSON.stringify(localAnalysis.suggested_actions),
          JSON.stringify(localAnalysis.related_accounts),
          JSON.stringify(localAnalysis.related_transactions),
          storedFileId,
        ],
      );
    } catch (error) {
      if (storedFileId) await this.storage.deleteFileById(storedFileId, userId);
      throw error;
    }
    const row = inserted.rows[0];

    void this.finalizeDocumentAnalysis(userId, row.id, dto, localAnalysis).catch(
      (error: unknown) => {
        const message =
          error instanceof Error ? error.message : 'Document analysis failed';
        // Best-effort failure mark; upload already succeeded.
        void this.pgPool.query(
          `UPDATE ai_documents
           SET status = 'failed',
               analysis_error = $3,
               updated_at = NOW()
           WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
          [row.id, userId, message.slice(0, 500)],
        );
      },
    );

    return row;
  }

  private async finalizeDocumentAnalysis(
    userId: string,
    documentId: string,
    dto: {
      name: string;
      mime_type: string;
      data_base64: string;
    },
    localAnalysis: ReturnType<AiAdvisorService['analyzeDocumentLocally']>,
  ) {
    const analysis = await this.analyzeDocumentWithProvider(
      userId,
      dto.name,
      dto.mime_type,
      dto.data_base64,
      localAnalysis,
    );

    await this.pgPool.query(
      `UPDATE ai_documents
       SET detected_type = $3,
           summary = $4,
           analysis_confidence = $5,
           extracted_sections = $6,
           suggested_actions = $7,
           related_accounts = $8,
           related_transactions = $9,
           status = 'ready',
           analysis_error = NULL,
           updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [
        documentId,
        userId,
        analysis.detected_type,
        analysis.summary,
        analysis.analysis_confidence,
        JSON.stringify(analysis.extracted_sections),
        JSON.stringify(analysis.suggested_actions),
        JSON.stringify(analysis.related_accounts),
        JSON.stringify(analysis.related_transactions),
      ],
    );
  }

  async deleteDocument(userId: string, id: string) {
    const result = await this.pgPool.query(
      `UPDATE ai_documents
       SET deleted_at = NOW(), updated_at = NOW(), content = NULL
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING id, stored_file_id`,
      [id, userId],
    );
    if (!result.rowCount) throw new NotFoundException('Document not found');
    this.releaseDocumentFiles(userId, result.rows);
    return { id };
  }

  private analyzeDocumentLocally(
    name: string,
    mimeType: string,
    buffer: Buffer,
  ) {
    const lower = name.toLowerCase();
    let detected_type = 'Document';
    if (mimeType.startsWith('image/')) detected_type = 'Image';
    else if (mimeType === 'application/pdf') detected_type = 'PDF';
    else if (mimeType.includes('csv')) detected_type = 'CSV export';
    else if (mimeType.includes('json')) detected_type = 'JSON data';
    else if (mimeType.startsWith('text/')) detected_type = 'Text note';

    if (/salary|payslip|pay.?slip/.test(lower)) detected_type = 'Salary slip';
    if (/statement|bank/.test(lower)) detected_type = 'Bank statement';
    if (/invoice|receipt/.test(lower)) detected_type = 'Invoice / receipt';
    if (/budget/.test(lower)) detected_type = 'Budget document';

    const textPreview =
      mimeType.startsWith('text/') || mimeType.includes('json')
        ? buffer.toString('utf8').slice(0, 2400)
        : '';

    const extracted_sections: Array<{ title: string; content: string }> = [];
    if (textPreview) {
      extracted_sections.push({
        title: 'Extracted text',
        content: textPreview.slice(0, 800),
      });
    } else {
      extracted_sections.push({
        title: 'File metadata',
        content: `${name} · ${mimeType} · ${(buffer.length / 1024).toFixed(1)} KB`,
      });
    }

    const suggested_actions = [
      'Ask Opal to summarize this document',
      'Find unusual expenses related to this file',
      'Create a budget or goal from the insights',
    ];

    return {
      detected_type,
      summary: textPreview
        ? `Parsed ${detected_type.toLowerCase()} and extracted readable text for analysis.`
        : `Stored ${detected_type.toLowerCase()} for advisor analysis. Attach it in chat for deeper extraction.`,
      analysis_confidence: textPreview ? 92 : 68,
      extracted_sections,
      suggested_actions,
      related_accounts: [] as string[],
      related_transactions: [] as Array<Record<string, unknown>>,
    };
  }

  private async analyzeDocumentWithProvider(
    userId: string,
    name: string,
    mimeType: string,
    dataBase64: string,
    fallback: ReturnType<AiAdvisorService['analyzeDocumentLocally']>,
  ) {
    // Errors propagate so finalizeDocumentAnalysis's caller marks the document
    // 'failed' (with analysis_error) instead of reporting a silent 'ready'.
    const [{ config }, twin] = await Promise.all([
      this.settingsService.loadActiveProviderConfig(userId),
      this.toolsService.gatherContext(userId).catch(() => ({
        context: {},
      })),
    ]);
    const prompt = [
      'Analyze this financial document for a contextual sidebar.',
      'Return ONLY valid JSON with this exact shape:',
      JSON.stringify({
        detected_type: 'string',
        summary: 'concise string, max 500 characters',
        analysis_confidence: 0,
        extracted_sections: [{ title: 'string', content: 'string' }],
        suggested_actions: ['string'],
        related_accounts: ['string'],
        related_transactions: [
          {
            date: 'YYYY-MM-DD',
            description: 'string',
            amount: 0,
          },
        ],
      }),
      'Use only evidence in the document and supplied financial context.',
      'Do not invent accounts or transactions. Use empty arrays when uncertain.',
      `File name: ${name}`,
      `Financial context: ${
        fitJsonToBudget(twin.context as Record<string, unknown>, 16000, {
          protect: ['user', 'accounts'],
        }).json
      }`,
    ].join('\n');
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: prompt,
        attachments: [
          {
            name,
            mimeType,
            dataBase64,
          },
        ],
      },
    ];
    const response = await runProviderChat(config, messages);
    const match = response.content.match(/```(?:json)?\s*([\s\S]*?)```/i);
    let parsed: any;
    try {
      parsed = JSON.parse((match?.[1] || response.content).trim());
    } catch {
      throw new Error('Document analysis returned invalid JSON.');
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Document analysis returned an unexpected shape.');
    }
    return {
      detected_type:
        String(parsed.detected_type || fallback.detected_type).slice(0, 80),
      summary: String(parsed.summary || fallback.summary).slice(0, 2000),
      analysis_confidence: Math.max(
        0,
        Math.min(100, Number(parsed.analysis_confidence) || 0),
      ),
      extracted_sections: Array.isArray(parsed.extracted_sections)
        ? parsed.extracted_sections.slice(0, 12).map((section: any) => ({
            title: String(section?.title || 'Section').slice(0, 120),
            content: String(section?.content || '').slice(0, 4000),
          }))
        : fallback.extracted_sections,
      suggested_actions: Array.isArray(parsed.suggested_actions)
        ? parsed.suggested_actions
            .slice(0, 8)
            .map((action: unknown) => String(action).slice(0, 240))
        : fallback.suggested_actions,
      related_accounts: Array.isArray(parsed.related_accounts)
        ? parsed.related_accounts
            .slice(0, 12)
            .map((account: unknown) => String(account).slice(0, 160))
        : [],
      related_transactions: Array.isArray(parsed.related_transactions)
        ? parsed.related_transactions.slice(0, 20)
        : [],
    };
  }

  async listMemories(userId: string) {
    const [prefs, memories] = await Promise.all([
      this.pgPool.query(
        `SELECT memory_enabled FROM user_ai_preferences WHERE user_id = $1`,
        [userId],
      ),
      this.pgPool.query(
        `SELECT id, content, source, source_conversation_id, created_at, updated_at
         FROM ai_memories WHERE user_id = $1
         ORDER BY updated_at DESC LIMIT 100`,
        [userId],
      ),
    ]);
    return {
      enabled: prefs.rows[0]?.memory_enabled !== false,
      memories: memories.rows,
    };
  }

  async addMemory(userId: string, content: string) {
    const normalized = content.trim();
    const existing = await this.pgPool.query(
      `SELECT id, content, source, created_at, updated_at
       FROM ai_memories
       WHERE user_id = $1 AND lower(content) = lower($2)
       LIMIT 1`,
      [userId, normalized],
    );
    if (existing.rowCount) return existing.rows[0];
    const result = await this.pgPool.query(
      `INSERT INTO ai_memories (user_id, content, source)
       VALUES ($1, $2, 'user')
       RETURNING id, content, source, created_at, updated_at`,
      [userId, normalized],
    );
    return result.rows[0];
  }

  async deleteMemory(userId: string, id: string) {
    const result = await this.pgPool.query(
      `DELETE FROM ai_memories WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, userId],
    );
    if (!result.rowCount) throw new NotFoundException('Memory not found');
    return result.rows[0];
  }

  async setMemoryEnabled(userId: string, enabled: boolean) {
    await this.pgPool.query(
      `INSERT INTO user_ai_preferences (user_id, memory_enabled)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE
       SET memory_enabled = EXCLUDED.memory_enabled, updated_at = NOW()`,
      [userId, enabled],
    );
    return { enabled };
  }

  async suggestCategoryIcon(
    userId: string,
    name: string,
    description?: string,
  ) {
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new BadRequestException('Category name is required');
    }
    const heuristic = suggestCategoryIconHeuristic(
      trimmedName,
      description || '',
    );

    try {
      const { config } =
        await this.settingsService.loadActiveProviderConfig(userId);
      const catalog = CATEGORY_ICON_IDS.join(', ');
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            'You pick one category icon id for a personal finance app. Reply with ONLY the icon id, nothing else.',
        },
        {
          role: 'user',
          content: [
            `Category name: ${trimmedName}`,
            `Description: ${(description || '').trim() || '(none)'}`,
            `Allowed icon ids: ${catalog}`,
            'Icon id:',
          ].join('\n'),
        },
      ];
      const response = await runProviderChat(config, messages);
      const raw = String(response.content || '')
        .split(/[\s,\n]/)[0]
        .replace(/["'`]/g, '')
        .trim()
        .toLowerCase()
        .replace(/_/g, '-');
      if (CATEGORY_ICON_IDS.includes(raw as (typeof CATEGORY_ICON_IDS)[number])) {
        return { icon: raw, source: 'ai' as const };
      }
      return { icon: heuristic, source: 'heuristic' as const };
    } catch {
      return { icon: heuristic, source: 'heuristic' as const };
    }
  }

  async chat(userId: string, dto: ChatMessageDto) {
    const prepared = await this.prepareChat(userId, dto);
    const result = isOmnirouteProvider(prepared.config.provider)
      ? await omnirouteAdapter.chatWithProgress(
          prepared.config,
          {
            model: prepared.config.model,
            messages: prepared.messages,
            maxContinuations: MAX_CONTINUATIONS,
          },
          () => undefined,
        )
      : await runProviderChat(prepared.config, prepared.messages, undefined, {
          maxContinuations: MAX_CONTINUATIONS,
        });
    const persisted = await this.persistAssistantTurn(
      prepared,
      result.content,
      result.model,
      {
        truncated: Boolean(result.truncated),
        finish_reason: result.truncated ? 'length' : 'stop',
        continuations: result.continuations || 0,
      },
    );
    if (
      isOmnirouteProvider(prepared.config.provider) &&
      !this.isLocalOpalFallback(result.model)
    ) {
      await this.omnirouteUsage.recordSuccessfulRequest(userId);
    }
    return persisted;
  }

  async *chatStream(
    userId: string,
    dto: ChatMessageDto,
    signal?: AbortSignal,
  ): AsyncGenerator<AiChatStreamEvent> {
    try {
      yield { type: 'status', message: 'Opening your Financial Twin…' };
      const prepared = await this.prepareChat(userId, dto);
      yield {
        type: 'meta',
        conversation_id: prepared.conversationId,
        provider: prepared.config.provider,
        model: prepared.config.model,
      };
      yield {
        type: 'context',
        tool_activity: prepared.activity,
        citations: prepared.citations,
      };

      let rawContent = '';
      let model = prepared.config.model;
      let truncated = false;
      let continuations = 0;

      if (isOmnirouteProvider(prepared.config.provider)) {
        yield { type: 'status', message: 'Asking a fast free model…' };
        const progressQueue: string[] = [];
        // Segments (first reply, then each continuation) stream as they land.
        const segmentQueue: string[] = [];
        let streamed = '';
        const resultPromise = omnirouteAdapter.chatWithProgress(
          prepared.config,
          {
            model: prepared.config.model,
            messages: prepared.messages,
            maxContinuations: MAX_CONTINUATIONS,
          },
          (message) => {
            progressQueue.push(message);
          },
          signal,
          (segment) => {
            segmentQueue.push(segment);
          },
        );
        const chunkSize = 18;

        while (true) {
          const raced = await Promise.race([
            resultPromise.then((value) => ({ done: true as const, value })),
            new Promise<{ done: false }>((resolve) =>
              setTimeout(() => resolve({ done: false }), 350),
            ),
          ]);
          while (progressQueue.length) {
            yield { type: 'status', message: progressQueue.shift()! };
          }
          while (segmentQueue.length) {
            const segment = segmentQueue.shift()!;
            for (let i = 0; i < segment.length; i += chunkSize) {
              if (signal?.aborted) throw new Error('Request cancelled');
              yield { type: 'delta', text: segment.slice(i, i + chunkSize) };
            }
            streamed += segment;
          }
          if (raced.done) {
            rawContent = raced.value.content;
            model = raced.value.model || model;
            truncated = Boolean(raced.value.truncated);
            continuations = raced.value.continuations || 0;
            break;
          }
          if (signal?.aborted) throw new Error('Request cancelled');
        }

        // Local Opal replies (and any unstreamed tail) are chunked here.
        const remainder = rawContent.startsWith(streamed)
          ? rawContent.slice(streamed.length)
          : '';
        if (remainder) {
          yield { type: 'status', message: 'Writing your Opal Advisor reply…' };
          for (let i = 0; i < remainder.length; i += chunkSize) {
            if (signal?.aborted) throw new Error('Request cancelled');
            yield { type: 'delta', text: remainder.slice(i, i + chunkSize) };
          }
        }
      } else {
        yield { type: 'status', message: 'Opal Advisor is thinking…' };
        const stream = runProviderChatStream(
          prepared.config,
          prepared.messages,
          signal,
          undefined,
          { maxContinuations: MAX_CONTINUATIONS },
        );
        while (true) {
          const next = await stream.next();
          if (next.done) {
            if (next.value?.model) model = next.value.model;
            if (next.value?.content) rawContent = next.value.content;
            truncated = Boolean(next.value?.truncated);
            continuations = next.value?.continuations || 0;
            break;
          }
          rawContent += next.value;
          yield { type: 'delta', text: next.value };
        }
      }

      yield { type: 'status', message: 'Preparing follow-ups…' };
      const persisted = await this.persistAssistantTurn(
        prepared,
        rawContent,
        model,
        {
          truncated,
          finish_reason: truncated ? 'length' : 'stop',
          continuations,
        },
      );
      if (
        isOmnirouteProvider(prepared.config.provider) &&
        !this.isLocalOpalFallback(model)
      ) {
        await this.omnirouteUsage.recordSuccessfulRequest(userId);
      }
      yield {
        type: 'done',
        conversation_id: persisted.conversation_id,
        conversation_title: persisted.conversation_title,
        message: persisted.message,
        proposals: persisted.proposals,
        provider: persisted.provider,
        model: persisted.model,
        tool_activity: persisted.tool_activity,
        citations: persisted.citations,
        suggested_questions: persisted.suggested_questions,
        truncated: persisted.truncated,
        finish_reason: persisted.finish_reason,
        continuations: persisted.continuations,
        content_sanitized: persisted.content_sanitized,
      };
    } catch (error: any) {
      if (signal?.aborted || error?.name === 'AbortError') {
        yield { type: 'error', message: 'Request cancelled' };
        return;
      }
      yield {
        type: 'error',
        message: extractAdvisorErrorMessage(error),
      };
    }
  }

  /**
   * The built-in canned reply (omniroute.adapter chatOnce → local_opal) reports
   * model 'omniroute/opal-local'; it costs nothing and must not burn free quota.
   */
  private isLocalOpalFallback(model: string | null | undefined): boolean {
    return String(model || '').startsWith('omniroute/opal-local');
  }

  private async prepareChat(userId: string, dto: ChatMessageDto) {
    const { config, masterPrompt } =
      await this.settingsService.loadActiveProviderConfig(userId);

    if (isOmnirouteProvider(config.provider)) {
      await this.omnirouteUsage.assertWithinQuota(userId);
    }
    // Opal Free backends have small per-minute token quotas (Groq rejects
    // ~20k-token prompts as "request too large", dropping the turn to a
    // slower/capped fallback). Send them a leaner prompt.
    const compactPrompt = isOmnirouteProvider(config.provider);

    let conversationId = dto.conversation_id;
    if (conversationId) {
      const existing = await this.pgPool.query(
        `SELECT id FROM ai_conversations
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [conversationId, userId],
      );
      if (!existing.rowCount) {
        throw new NotFoundException('Conversation not found');
      }
    } else {
      const created = await this.pgPool.query(
        `INSERT INTO ai_conversations (user_id, title, provider, model)
         VALUES ($1, $2, $3, $4)
         RETURNING id, title, provider, model, created_at, updated_at`,
        [userId, 'New chat', config.provider, config.model],
      );
      conversationId = created.rows[0].id;
    }

    await this.pgPool.query(
      `INSERT INTO ai_messages
        (conversation_id, user_id, role, content, attachments, provider, model)
       VALUES ($1, $2, 'user', $3, $4, $5, $6)`,
      [
        conversationId,
        userId,
        dto.content.trim(),
        JSON.stringify(
          (dto.attachments || []).map((file) => ({
            name: file.name,
            mime_type: file.mime_type,
          })),
        ),
        config.provider,
        config.model,
      ],
    );

    const explicitMemory = this.extractExplicitMemory(dto.content);
    if (explicitMemory) {
      await this.pgPool.query(
        `INSERT INTO ai_memories
          (user_id, content, source, source_conversation_id)
         SELECT $1, $2, 'conversation', $3
         WHERE NOT EXISTS (
           SELECT 1 FROM ai_memories
           WHERE user_id = $1 AND lower(content) = lower($2)
         )`,
        [userId, explicitMemory, conversationId],
      );
    }

    // Newest 24 turns (the current user message included), replayed oldest-first.
    const history = await this.pgPool.query(
      `SELECT role, content FROM (
         SELECT role, content, created_at FROM ai_messages
         WHERE conversation_id = $1 AND user_id = $2 AND role IN ('user', 'assistant')
           AND (role = 'user' OR COALESCE(BTRIM(content), '') <> '')
         ORDER BY created_at DESC
         LIMIT $3
       ) recent
       ORDER BY created_at ASC`,
      [conversationId, userId, compactPrompt ? 12 : 24],
    );

    const preferences = await this.pgPool.query(
      `SELECT memory_enabled FROM user_ai_preferences WHERE user_id = $1`,
      [userId],
    );
    const memoryEnabled = preferences.rows[0]?.memory_enabled !== false;
    const memories = memoryEnabled
      ? await this.pgPool.query(
          `SELECT content FROM ai_memories
           WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 30`,
          [userId],
        )
      : { rows: [] };
    const recentAcrossChats = memoryEnabled
      ? await this.pgPool.query(
          `SELECT m.role, m.content, c.title
           FROM ai_messages m
           JOIN ai_conversations c ON c.id = m.conversation_id
           WHERE m.user_id = $1 AND m.conversation_id <> $2
             AND c.deleted_at IS NULL
             AND m.role IN ('user', 'assistant')
           ORDER BY m.created_at DESC LIMIT 12`,
          [userId, conversationId],
        )
      : { rows: [] };

    const { context, activity, citations } =
      await this.toolsService.gatherContext(userId, {
        deepTools: this.resolveInvokedTools(dto),
      });
    const slash = parseSlashCommand(dto.content);
    let effectiveContent = dto.content.trim();
    if (slash) {
      const rest = effectiveContent
        .replace(new RegExp(`^\\${slash.command}\\b`, 'i'), '')
        .trim();
      effectiveContent = rest
        ? `${slash.prompt}\n\nUser note: ${rest}`
        : slash.prompt;
    }

    const useWebSearch =
      dto.web_search === true ||
      slash?.web_search === true ||
      this.resolveInvokedTools(dto).includes('search_public_web') ||
      this.webSearchService.shouldSearchAutomatically(effectiveContent);

    if (useWebSearch) {
      if (this.webSearchService.available) {
        try {
          const web = await this.webSearchService.search(effectiveContent);
          if (web.sources.length) {
            context.web_sources = web.context;
            citations.push(...web.sources);
            activity.push({
              name: 'search_public_web',
              status: 'ok',
              summary: `${web.sources.length} current public sources`,
            });
          }
        } catch (error: any) {
          activity.push({
            name: 'search_public_web',
            status: 'error',
            summary: error?.message || 'Web search unavailable',
          });
        }
      } else {
        activity.push({
          name: 'search_public_web',
          status: 'error',
          summary: 'Tavily is not configured',
        });
      }
    }

    const invoked = this.resolveInvokedTools(dto);
    // Most important first: the model needs user/accounts/categories for
    // every proposal, and the budgeter trims bulky lists before those.
    const orderedContext: Record<string, unknown> = {};
    for (const key of [
      'user',
      'accounts',
      'categories',
      'overview',
      'cash_flow',
      'budgets',
      'goals',
      'loans',
      'recurring',
      'uncategorized_transactions',
      'recent_transactions',
      'investments',
      'spaces',
      'scenario',
      'fx_sample',
      'invoked_tools',
    ]) {
      if (context[key] !== undefined) orderedContext[key] = context[key];
    }
    for (const [key, value] of Object.entries(context)) {
      if (key !== 'web_sources' && !(key in orderedContext)) {
        orderedContext[key] = value;
      }
    }
    const twinBudget = compactPrompt ? 18000 : invoked.length ? 64000 : 48000;
    const twinJson = fitJsonToBudget(orderedContext, twinBudget, {
      protect: ['user', 'accounts', 'categories', 'invoked_tools'],
    }).json;
    const system = [
      buildSystemPrompt(masterPrompt),
      memoryEnabled
        ? [
            'Durable user memory (user-controlled; use when relevant):',
            fitStringList(
              memories.rows.map((row) => String(row.content)),
              compactPrompt ? 3000 : 12000,
              600,
            ),
            'Recent context from other conversations (oldest to newest):',
            JSON.stringify(
              [...recentAcrossChats.rows]
                .reverse()
                .slice(compactPrompt ? -6 : -12)
                .map((row) => ({
                  role: row.role,
                  chat: row.title,
                  content: String(row.content || '')
                    .replace(/\s+/g, ' ')
                    .slice(0, compactPrompt ? 300 : 900),
                })),
            ),
          ].join('\n')
        : 'Cross-conversation memory is disabled by the user.',
      invoked.length
        ? `User-invoked tools for this turn (@ / slash): ${invoked.join(', ')}. Prioritize these datasets.`
        : 'No explicit @ or / tool invocation for this turn.',
      'Live Opal twin context (JSON):',
      twinJson,
      context.web_sources
        ? [
            'Current public web sources are included above.',
            'Use them only for public facts, clearly distinguish them from the user’s Opal data, and cite claims with descriptive Markdown links to the supplied URLs.',
            'Never fabricate a citation or image.',
            `Public web source excerpts (JSON): ${JSON.stringify(context.web_sources).slice(0, 12000)}`,
          ].join(' ')
        : 'No live web sources were requested for this answer.',
    ].join('\n\n');

    const messages: ChatMessage[] = [
      { role: 'system' as const, content: system },
      ...history.rows
        // Empty assistant turns (proposal-only replies from older rows) make
        // some providers reject the request; the user turn is always kept.
        .filter(
          (m) => m.role === 'user' || String(m.content ?? '').trim().length > 0,
        )
        .map((m, index, rows) => {
          const content = String(m.content);
          // Lean prompt: older turns are trimmed, the newest turns kept whole.
          const keepWhole = !compactPrompt || index >= rows.length - 2;
          return {
            role: m.role as 'user' | 'assistant',
            content:
              keepWhole || content.length <= 2500
                ? content
                : `${content.slice(0, 2500)}…`,
          };
        }),
    ];
    // The user turn inserted above is the newest row, so it is the last user
    // message here; swap in the slash-expanded prompt for the provider.
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUser) {
      lastUser.content = effectiveContent;
    }
    if (dto.attachments?.length && lastUser) {
      lastUser.attachments = dto.attachments.map((file) => ({
        name: file.name,
        mimeType: file.mime_type,
        dataBase64: file.data_base64,
      }));
    }

    return {
      userId,
      config,
      conversationId: conversationId as string,
      userPrompt: effectiveContent,
      originalUserPrompt: dto.content.trim(),
      messages,
      context,
      activity,
      citations,
    };
  }

  commandCatalog() {
    return this.toolsService.commandCatalog();
  }

  private resolveInvokedTools(dto: ChatMessageDto): string[] {
    const tools = new Set<string>();
    for (const raw of dto.invoked_tools || []) {
      const normalized = this.normalizeToolName(raw);
      if (normalized) tools.add(normalized);
    }
    for (const tool of parseAtMentions(dto.content || '')) {
      tools.add(tool);
    }
    const slash = parseSlashCommand(dto.content || '');
    if (slash) {
      for (const tool of slash.tools) tools.add(tool);
    }
    return [...tools];
  }

  private normalizeToolName(raw: string): string | null {
    const key = String(raw || '')
      .trim()
      .toLowerCase()
      .replace(/^@/, '')
      .replace(/^\//, '');
    if (!key) return null;
    const byTool = AI_AT_TOOLS.find((t) => t.tool === key || t.id === key);
    if (byTool) return byTool.tool;
    const bySlash = AI_SLASH_COMMANDS.find(
      (c) => c.id === key || c.command === `/${key}`,
    );
    if (bySlash) return bySlash.tools[0] || null;
    return null;
  }

  private extractExplicitMemory(content: string): string | null {
    const match = content.trim().match(
      /^(?:please\s+)?remember(?:\s+that)?\s*[:,-]?\s+(.{2,1000})$/i,
    );
    return match?.[1]?.trim() || null;
  }

  private async persistAssistantTurn(
    prepared: {
      userId: string;
      config: Awaited<
        ReturnType<AiSettingsService['loadActiveProviderConfig']>
      >['config'];
      conversationId: string;
      userPrompt: string;
      originalUserPrompt?: string;
      messages: ChatMessage[];
      context: Record<string, unknown>;
      activity: Array<{ name: string; status: string; summary: string }>;
      citations: Citation[];
    },
    rawContent: string,
    model: string,
    meta: ReplyMeta = { truncated: false, finish_reason: 'stop', continuations: 0 },
  ) {
    const parsed = this.extractProposals(rawContent);
    const stripped = this.stripSensitiveIdentifiers(
      this.stripBrokenProposalFences(parsed.cleanedContent),
    );
    // Mermaid validation / auto-fix and closing of fences left open by a cut
    // reply, so the saved message always renders.
    const sanitized = sanitizeAssistantMarkdown(stripped);
    let cleanContent = sanitized.content;
    const userId = prepared.userId;

    const validated = await this.validateProposals(
      userId,
      parsed.proposals,
      prepared,
    );
    const proposals = [...validated.proposals];
    if (validated.clarifications.length) {
      cleanContent = [
        cleanContent.trim(),
        `**Before I can set ${validated.clarifications.length === 1 ? 'this' : 'these'} up, I need a quick answer:**`,
        validated.clarifications.map((q) => `- ${q}`).join('\n'),
      ]
        .filter(Boolean)
        .join('\n\n');
    }
    const createCategoryCount = proposals.filter(
      (p) => p.action_type === 'create_category',
    ).length;
    const seedIntent = wantsCategorySeed(
      prepared.originalUserPrompt || prepared.userPrompt,
    );

    // Models routinely truncate large create_category lists. When the user asked
    // to seed categories and no valid proposals were parsed, attach a built-in set.
    if (seedIntent && createCategoryCount === 0) {
      const existing = Array.isArray(prepared.context.categories)
        ? (prepared.context.categories as Array<{ name?: string }>)
            .map((c) => String(c?.name || ''))
            .filter(Boolean)
        : [];
      const seeded = buildSeedCategoryProposals(existing);
      proposals.push(...seeded);
      if (seeded.length && !/pending actions|confirm/i.test(cleanContent)) {
        cleanContent =
          `${cleanContent.trim()}\n\nI've attached **${seeded.length} create_category** proposals for your review — use Review / Review all to approve them.`.trim();
      }
    }

    // Never persist an empty assistant turn: it renders as a blank bubble and
    // poisons the history replayed to providers on the next turn.
    if (!cleanContent.trim()) {
      cleanContent = proposals.length
        ? `Proposed ${proposals.length} action${proposals.length === 1 ? '' : 's'} for review.`
        : 'I could not produce a reply this time. Please try asking again.';
    }

    const proposalIds: string[] = [];
    const proposalRows: any[] = [];
    for (const proposal of proposals) {
      const inserted = await this.pgPool.query(
        `INSERT INTO ai_action_proposals
          (user_id, conversation_id, action_type, title, summary, payload, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW() + INTERVAL '30 minutes')
         RETURNING id, action_type, title, summary, payload, status, expires_at, created_at`,
        [
          userId,
          prepared.conversationId,
          proposal.action_type,
          proposal.title,
          proposal.summary || null,
          JSON.stringify(proposal.payload || {}),
        ],
      );
      proposalIds.push(inserted.rows[0].id);
      proposalRows.push(inserted.rows[0]);
    }

    const assistant = await this.pgPool.query(
      `INSERT INTO ai_messages
        (conversation_id, user_id, role, content, tool_activity, citations, proposal_ids, provider, model)
       VALUES ($1, $2, 'assistant', $3, $4, $5, $6, $7, $8)
       RETURNING id, role, content, tool_activity, citations, proposal_ids, provider, model, created_at`,
      [
        prepared.conversationId,
        userId,
        cleanContent,
        JSON.stringify(prepared.activity),
        JSON.stringify(prepared.citations),
        JSON.stringify(proposalIds),
        prepared.config.provider,
        model,
      ],
    );

    await this.pgPool.query(
      `UPDATE ai_conversations
       SET updated_at = NOW(),
           provider = $3,
           model = $4,
           last_message_preview = $5
       WHERE id = $1 AND user_id = $2`,
      [
        prepared.conversationId,
        userId,
        prepared.config.provider,
        model,
        cleanContent.replace(/\s+/g, ' ').trim().slice(0, 160),
      ],
    );

    const conversationTitle = await this.maybeAutoTitleConversation(
      userId,
      prepared.conversationId,
      prepared.config,
    );

    const suggestedQuestions: string[] = [];
    const replyMeta = {
      truncated: meta.truncated,
      finish_reason: meta.finish_reason,
      continuations: meta.continuations,
    };

    return {
      conversation_id: prepared.conversationId,
      conversation_title: conversationTitle,
      // ai_messages has no metadata column; the flags ride on the returned
      // message (top level + `metadata`) for the client's Continue button.
      message: { ...assistant.rows[0], ...replyMeta, metadata: replyMeta },
      proposals: proposalRows,
      provider: prepared.config.provider,
      model,
      tool_activity: prepared.activity,
      citations: prepared.citations,
      suggested_questions: suggestedQuestions,
      ...replyMeta,
      content_sanitized: sanitized.changed || validated.clarifications.length > 0,
    };
  }

  /**
   * Check every write proposal against the user's real accounts/categories:
   * repair what can be repaired (names → ids, transfer classification,
   * category, description, timezone-correct date, currency) and turn the
   * rest into clarification questions instead of cards that would fail.
   */
  private async validateProposals(
    userId: string,
    proposals: ParsedProposal[],
    prepared: { context: Record<string, unknown>; originalUserPrompt?: string; userPrompt: string },
  ): Promise<{ proposals: ParsedProposal[]; clarifications: string[] }> {
    const needsCheck = proposals.some(
      (p) => TRANSACTION_PROPOSALS.has(p.action_type) || REFERENCE_PROPOSALS.has(p.action_type),
    );
    if (!needsCheck) return { proposals, clarifications: [] };

    let ctx: ProposalContext;
    try {
      ctx = await this.toolsService.proposalContext(
        userId,
        prepared.originalUserPrompt || prepared.userPrompt,
      );
    } catch {
      return { proposals, clarifications: [] };
    }

    const kept: ParsedProposal[] = [];
    const clarifications: string[] = [];
    for (const proposal of proposals) {
      if (TRANSACTION_PROPOSALS.has(proposal.action_type)) {
        const outcome = validateTransactionProposal(
          proposal.action_type,
          proposal.payload || {},
          ctx,
        );
        if (!outcome.ok) {
          if (outcome.clarification) clarifications.push(outcome.clarification);
          continue;
        }
        kept.push({
          ...proposal,
          title: (outcome.title || proposal.title).slice(0, 200),
          summary: outcome.summary || proposal.summary,
          payload: outcome.payload,
        });
      } else if (REFERENCE_PROPOSALS.has(proposal.action_type)) {
        const outcome = repairReferenceIds(
          proposal.action_type,
          proposal.payload || {},
          ctx,
        );
        if (!outcome.ok) {
          if (outcome.clarification) clarifications.push(outcome.clarification);
          continue;
        }
        kept.push({ ...proposal, payload: outcome.payload });
      } else {
        kept.push(proposal);
      }
    }
    return { proposals: kept, clarifications: [...new Set(clarifications)] };
  }

  /**
   * ChatGPT-style naming: after the first assistant reply, generate a short
   * human title once. Skips when already auto-titled or manually renamed.
   */
  private async maybeAutoTitleConversation(
    userId: string,
    conversationId: string,
    config: Awaited<
      ReturnType<AiSettingsService['loadActiveProviderConfig']>
    >['config'],
  ): Promise<string | null> {
    const conv = await this.pgPool.query(
      `SELECT title, auto_titled_at FROM ai_conversations
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [conversationId, userId],
    );
    if (!conv.rowCount) return null;
    const { title, auto_titled_at } = conv.rows[0] as {
      title: string;
      auto_titled_at: string | null;
    };
    if (auto_titled_at) return title;

    const history = await this.pgPool.query(
      `SELECT role, content FROM ai_messages
       WHERE conversation_id = $1 AND user_id = $2 AND role IN ('user', 'assistant')
       ORDER BY created_at ASC
       LIMIT 4`,
      [conversationId, userId],
    );
    const userMsg = history.rows.find((row) => row.role === 'user')?.content;
    const assistantMsg = history.rows.find(
      (row) => row.role === 'assistant',
    )?.content;
    if (!userMsg || !assistantMsg) return title;

    const current = String(title || '').trim();
    const legacySnippet =
      String(userMsg).trim().slice(0, 60) +
      (String(userMsg).trim().length > 60 ? '…' : '');
    const needsTitle =
      !current ||
      current === 'New chat' ||
      current === 'New conversation' ||
      current === legacySnippet;
    if (!needsTitle) {
      await this.pgPool.query(
        `UPDATE ai_conversations
         SET auto_titled_at = NOW()
         WHERE id = $1 AND user_id = $2`,
        [conversationId, userId],
      );
      return current;
    }

    let nextTitle = this.heuristicConversationTitle(String(userMsg));
    try {
      const generated = await this.generateConversationTitleWithProvider(
        config,
        String(userMsg),
        String(assistantMsg),
      );
      if (generated) nextTitle = generated;
    } catch {
      // Keep heuristic title.
    }

    nextTitle = nextTitle.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New chat';
    await this.pgPool.query(
      `UPDATE ai_conversations
       SET title = $3,
           auto_titled_at = NOW(),
           updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [conversationId, userId, nextTitle],
    );
    return nextTitle;
  }

  private heuristicConversationTitle(userMessage: string): string {
    let text = userMessage
      .replace(/\r\n/g, '\n')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/^\s*\/[a-z0-9_-]+\b/i, '')
      .replace(/@[a-z0-9_-]+\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return 'New chat';
    const words = text.split(' ').slice(0, 6);
    let title = words.join(' ');
    if (text.split(' ').length > 6) title = `${title}…`;
    return title.charAt(0).toUpperCase() + title.slice(1);
  }

  private async generateConversationTitleWithProvider(
    config: Awaited<
      ReturnType<AiSettingsService['loadActiveProviderConfig']>
    >['config'],
    userMessage: string,
    assistantMessage: string,
  ): Promise<string | null> {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'Create a short chat title like ChatGPT. Rules: 2–6 words, Title Case when natural, no quotes, no trailing punctuation, no emojis, no markdown. Reply with the title only.',
      },
      {
        role: 'user',
        content: [
          `User: ${userMessage.replace(/\s+/g, ' ').trim().slice(0, 400)}`,
          `Assistant: ${assistantMessage.replace(/\s+/g, ' ').trim().slice(0, 400)}`,
          'Title:',
        ].join('\n'),
      },
    ];
    const response = await runProviderChat(config, messages);
    const raw = String(response.content || '')
      .split('\n')[0]
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/^title\s*:\s*/i, '')
      .trim();
    if (!raw || raw.length < 2 || raw.length > 80) return null;
    if (/^(new chat|untitled|conversation)$/i.test(raw)) return null;
    return raw;
  }

  /**
   * Never persist UUIDs / machine IDs into chat content shown to users.
   * Only text around a removed id is tidied: indentation (code, nested
   * lists), task-list "[ ]" boxes and code blocks are left untouched — the
   * old global whitespace collapse mangled saved replies.
   */
  private stripSensitiveIdentifiers(content: string): string {
    const uuid =
      '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
    const MARK = '\u0001';
    const marked = content
      .replace(
        new RegExp(
          `[ \\t]*[\\(\\[][ \\t]*(?:id|uuid|container[_ ]?id|category[_ ]?id|account[_ ]?id)[ \\t]*[:#]?[ \\t]*\`?${uuid}\`?[ \\t]*[\\)\\]]`,
          'gi',
        ),
        MARK,
      )
      .replace(
        new RegExp(
          `\\b(?:id|uuid|container_id|category_id|account_id|source_container_id|destination_container_id)[ \\t]*[:=][ \\t]*\`?${uuid}\`?`,
          'gi',
        ),
        MARK,
      )
      .replace(new RegExp(`\`${uuid}\``, 'gi'), MARK)
      .replace(new RegExp(`\\b${uuid}\\b`, 'gi'), MARK);
    if (!marked.includes(MARK)) return content.trim();
    return marked
      .replace(new RegExp(`[\\(\\[][ \\t]*${MARK}[ \\t]*[\\)\\]]`, 'g'), MARK)
      .replace(new RegExp(`(\\S)[ \\t]+${MARK}[ \\t]*(?=\\S)`, 'g'), '$1 ')
      .replace(new RegExp(`[ \\t]*${MARK}[ \\t]*`, 'g'), '')
      .trim();
  }

  /**
   * Drop proposal fences that extractProposals could not ingest:
   * - complete ```action_proposal blocks (internal protocol, never user-facing);
   * - a trailing unterminated ```action_proposal fence (cut-off internal JSON).
   * A trailing unterminated ```json (or any other) fence is user-visible
   * content from a cut reply: it is kept and closed by the markdown sanitizer.
   */
  private stripBrokenProposalFences(content: string): string {
    let text = content.replace(/```action_proposal\b[\s\S]*?```/gi, '');
    const fences = [...text.matchAll(/```/g)];
    if (fences.length % 2 === 1) {
      const lastOpen = fences[fences.length - 1].index ?? -1;
      const tail = lastOpen >= 0 ? text.slice(lastOpen) : '';
      // A cut ```json block is only dropped when it is clearly a proposal.
      if (
        /^```action_proposal\b/i.test(tail) ||
        (/^```json\b/i.test(tail) && /"action_type"\s*:/.test(tail))
      ) {
        text = text.slice(0, lastOpen);
      }
    }
    return text.trim();
  }

  private async generateSuggestedQuestions(
    config: Awaited<
      ReturnType<AiSettingsService['loadActiveProviderConfig']>
    >['config'],
    userPrompt: string,
    assistantContent: string,
    context: Record<string, unknown>,
  ): Promise<string[]> {
    try {
      const result = await runProviderChat(
        config,
        [
          {
            role: 'system',
            content: [
              'Generate exactly four concise follow-up questions for a financial AI conversation.',
              'Each question must directly continue the user question and assistant answer.',
              'Make the questions specific, useful, and distinct—not generic.',
              'Do not mention APIs, tools, implementation details, or raw application routes.',
              'Do not repeat a question already answered.',
              'Return only a valid JSON array of four strings, with no Markdown or explanation.',
            ].join(' '),
          },
          {
            role: 'user',
            content: [
              `Original question:\n${userPrompt.slice(0, 4000)}`,
              `Assistant answer:\n${assistantContent.slice(0, 10000)}`,
            ].join('\n\n'),
          },
        ],
        512,
      );

      const parsed = this.parseSuggestedQuestions(result.content);
      if (parsed.length >= 2) return parsed.slice(0, 4);
    } catch {
      // Keep the conversation usable when follow-up generation is unavailable.
    }

    return this.suggestedQuestions(context, userPrompt, assistantContent).slice(
      0,
      4,
    );
  }

  private parseSuggestedQuestions(content: string): string[] {
    const arrayMatch = content.match(/\[[\s\S]*\]/);
    if (!arrayMatch) return [];

    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (!Array.isArray(parsed)) return [];
      return [
        ...new Set(
          parsed
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter((item) => item.length >= 8 && item.length <= 180),
        ),
      ];
    } catch {
      return [];
    }
  }

  async confirmProposal(userId: string, proposalId: string) {
    // Atomically claim the proposal without holding a pooled client across the
    // (multi-connection) execution. The status CHECK constraint only allows
    // pending/confirmed/rejected/expired/failed, so the claim moves it straight
    // to 'confirmed'; a failed execution is then recorded as 'failed'. A second
    // concurrent confirm finds no pending row and cannot execute it twice.
    const claimed = await this.pgPool.query(
      `UPDATE ai_action_proposals
       SET status = 'confirmed', updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status = 'pending' AND expires_at > NOW()
       RETURNING *`,
      [proposalId, userId],
    );

    if (!claimed.rowCount) {
      const existing = await this.pgPool.query(
        `SELECT status, expires_at FROM ai_action_proposals
         WHERE id = $1 AND user_id = $2`,
        [proposalId, userId],
      );
      if (!existing.rowCount) {
        throw new NotFoundException('Proposal not found');
      }
      const current = existing.rows[0];
      if (current.status === 'pending') {
        await this.pgPool.query(
          `UPDATE ai_action_proposals
           SET status = 'expired', updated_at = NOW()
           WHERE id = $1 AND user_id = $2 AND status = 'pending'`,
          [proposalId, userId],
        );
        throw new BadRequestException('Proposal expired. Ask Opal again.');
      }
      throw new BadRequestException(`Proposal is already ${current.status}`);
    }

    const row = claimed.rows[0];
    let executed: unknown;
    try {
      executed = await this.toolsService.executeProposal(
        userId,
        row.action_type,
        row.payload || {},
      );
    } catch (error) {
      const extracted = extractAdvisorErrorMessage(error);
      const message =
        extracted === 'Advisor stream failed'
          ? 'Failed to execute proposal'
          : extracted;
      await this.pgPool.query(
        `UPDATE ai_action_proposals
         SET status = 'failed', result = $3, updated_at = NOW()
         WHERE id = $1 AND user_id = $2`,
        [proposalId, userId, JSON.stringify({ error: message })],
      );
      if (error instanceof HttpException) throw error;
      throw new BadRequestException(message);
    }

    await this.pgPool.query(
      `UPDATE ai_action_proposals
       SET executed_at = NOW(), result = $3, updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [proposalId, userId, JSON.stringify(executed ?? null)],
    );
    return {
      id: proposalId,
      status: 'confirmed',
      result: executed,
    };
  }

  async rejectProposal(userId: string, proposalId: string) {
    const result = await this.pgPool.query(
      `UPDATE ai_action_proposals
       SET status = 'rejected', updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status = 'pending'
       RETURNING id, status`,
      [proposalId, userId],
    );
    if (!result.rowCount) {
      throw new NotFoundException('Pending proposal not found');
    }
    return result.rows[0];
  }

  async bulkDecideProposals(
    userId: string,
    confirmIds: string[] = [],
    rejectIds: string[] = [],
  ) {
    const confirmSet = [...new Set(confirmIds.filter(Boolean))];
    const rejectSet = [...new Set(rejectIds.filter(Boolean))].filter(
      (id) => !confirmSet.includes(id),
    );

    if (!confirmSet.length && !rejectSet.length) {
      throw new BadRequestException('No proposal IDs provided');
    }
    if (confirmSet.length + rejectSet.length > 100) {
      throw new BadRequestException('At most 100 proposals per bulk request');
    }

    const confirmed: Array<Record<string, unknown>> = [];
    const rejected: Array<Record<string, unknown>> = [];
    const failed: Array<{ id: string; action: string; error: string }> = [];

    for (const id of confirmSet) {
      try {
        confirmed.push(await this.confirmProposal(userId, id));
      } catch (error: any) {
        failed.push({
          id,
          action: 'confirm',
          error: error?.message || 'Confirm failed',
        });
      }
    }

    for (const id of rejectSet) {
      try {
        rejected.push(await this.rejectProposal(userId, id));
      } catch (error: any) {
        failed.push({
          id,
          action: 'reject',
          error: error?.message || 'Reject failed',
        });
      }
    }

    return {
      confirmed,
      rejected,
      failed,
      summary: {
        confirmed: confirmed.length,
        rejected: rejected.length,
        failed: failed.length,
      },
    };
  }

  async starterPrompts(userId: string) {
    try {
      const { context } = await this.toolsService.gatherContext(userId);
      return {
        questions: this.suggestedQuestions(context),
      };
    } catch {
      return {
        questions: [
          'Where is my money right now?',
          'Am I overspending this month?',
          'How are my goals progressing?',
          'What should I do next financially?',
        ],
      };
    }
  }

  private extractProposals(content: string): {
    cleanedContent: string;
    proposals: ParsedProposal[];
  } {
    const proposals: ParsedProposal[] = [];

    // Prefer labeled fences, but also accept ```json (models often ignore the
    // action_proposal label). Strip only when at least one proposal was parsed.
    const cleanedContent = content.replace(
      /```(?:action_proposal|json)\s*([\s\S]*?)```/gi,
      (match, json) => {
        const before = proposals.length;
        this.ingestProposalJson(String(json).trim(), proposals);
        return proposals.length > before ? '' : match;
      },
    );

    return { cleanedContent: cleanedContent.trim(), proposals };
  }

  /** Accept a single object, an array, or NDJSON lines of action proposals. */
  private ingestProposalJson(raw: string, out: ParsedProposal[]) {
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const proposal = this.normalizeProposal(item);
          if (proposal) out.push(proposal);
        }
        return;
      }
      const single = this.normalizeProposal(parsed);
      if (single) {
        out.push(single);
        return;
      }
    } catch {
      /* fall through to NDJSON */
    }

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '[' || trimmed === ']' || trimmed === ',') {
        continue;
      }
      try {
        const proposal = this.normalizeProposal(JSON.parse(trimmed));
        if (proposal) out.push(proposal);
      } catch {
        /* ignore malformed line */
      }
    }
  }

  private normalizeProposal(value: unknown): ParsedProposal | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const raw = value as Record<string, unknown>;
    const actionType = raw.action_type ? String(raw.action_type) : '';
    if (
      !actionType ||
      !(SUPPORTED_ACTION_TYPES as readonly string[]).includes(actionType)
    ) {
      return null;
    }

    let payload: Record<string, unknown> =
      typeof raw.payload === 'object' &&
      raw.payload &&
      !Array.isArray(raw.payload)
        ? { ...(raw.payload as Record<string, unknown>) }
        : {};

    // Models sometimes put fields at the top level instead of under payload.
    if (!Object.keys(payload).length) {
      const {
        action_type: _a,
        title: _t,
        summary: _s,
        ...rest
      } = raw;
      payload = rest;
    }

    const title =
      (raw.title ? String(raw.title).trim() : '') ||
      this.synthesizeProposalTitle(actionType, payload);
    if (!title) return null;

    return {
      action_type: actionType,
      // ai_action_proposals.title is VARCHAR(200); a longer model title
      // would fail the INSERT and lose the whole reply.
      title: title.slice(0, 200),
      summary: raw.summary ? String(raw.summary) : undefined,
      payload,
    };
  }

  private synthesizeProposalTitle(
    actionType: string,
    payload: Record<string, unknown>,
  ): string {
    const name =
      (payload.name ? String(payload.name).trim() : '') ||
      (payload.title ? String(payload.title).trim() : '') ||
      (payload.description ? String(payload.description).trim() : '');
    const label = actionType.replace(/_/g, ' ');
    if (name) return `${label}: ${name}`.slice(0, 120);
    return label;
  }

  private suggestedQuestions(
    context: Record<string, unknown>,
    userPrompt = '',
    assistantContent = '',
  ): string[] {
    const prompt = userPrompt.toLowerCase();
    const conversation = `${userPrompt} ${assistantContent}`.toLowerCase();

    if (prompt || assistantContent) {
      if (/document|statement|pdf|csv|receipt|invoice|upload/.test(conversation)) {
        return [
          'Which transactions in this document need my attention?',
          'Are there any errors, duplicates, or unusual charges?',
          'Compare this document with my connected accounts.',
          'What action should I take based on this document?',
        ];
      }
      if (/budget|overspend|spending limit/.test(prompt)) {
        return [
          'Which budget categories should I adjust first?',
          'Show me a more conservative budget option.',
          'How would this budget affect my savings goals?',
          'Turn this recommendation into a budget I can confirm.',
        ];
      }
      if (/spend|expense|transaction|money go|categor/.test(prompt)) {
        return [
          'Which expenses are unusual or avoidable?',
          'Compare this spending with the previous month.',
          'Which category offers the biggest saving opportunity?',
          'Create an action plan to reduce this spending.',
        ];
      }
      if (/goal|save|saving|emergency fund/.test(prompt)) {
        return [
          'How much should I save each month to reach this goal?',
          'What could delay this goal?',
          'Show me a faster and a safer plan.',
          'Turn this into a goal I can track.',
        ];
      }
      if (/debt|loan|liabilit|repay|credit/.test(prompt)) {
        return [
          'Which debt should I pay down first?',
          'Compare avalanche and snowball repayment plans.',
          'How much interest could I save?',
          'Build a monthly debt repayment plan.',
        ];
      }
      if (/invest|portfolio|holding|stock|fund|return/.test(prompt)) {
        return [
          'Where is my portfolio most concentrated?',
          'How has this performed over time?',
          'What risks should I review first?',
          'How does this affect my broader financial plan?',
        ];
      }
      if (/income|cash flow|net worth|financial health|overview/.test(prompt)) {
        return [
          'What is the biggest risk in my current finances?',
          'Compare my cash flow with the previous month.',
          'Which recommendation should I act on first?',
          'Build a 30-day financial improvement plan.',
        ];
      }

      return [
        'Explain the most important insight in more detail.',
        'What is the biggest risk I should consider?',
        'What should I do first based on this answer?',
        'Show me an alternative approach.',
      ];
    }

    const overview: any = context.overview || {};
    const twin = overview.twin || {};
    const month = overview.this_month || {};
    const questions = [
      'Summarize my financial twin in 5 bullets.',
      'Where did my money go this month?',
    ];
    if (Number(month.expense) > 0) {
      questions.push('Which categories are draining cash the most?');
    }
    if (Number(twin.liabilities) > 0) {
      questions.push('How risky are my liabilities right now?');
    }
    questions.push('Propose a monthly budget I can confirm.');
    questions.push('What should I do next week to improve savings?');
    return questions.slice(0, 6);
  }

  async generatePeriodInsights(
    userId: string,
    snapshot: {
      user: { currency: string };
      period: { label: string; frequency: string; start: string; end: string };
      totals: object;
      previous: object;
      twin: object;
      spending_by_category: unknown[];
      income_by_category: unknown[];
      top_merchants: unknown[];
      budgets: { items?: unknown[]; over_count?: number };
      goals: unknown[];
      loans: unknown[];
      investments: Record<string, unknown> | object;
      largest_expenses: unknown[];
    },
  ): Promise<string | null> {
    try {
      const { config, masterPrompt } =
        await this.settingsService.loadActiveProviderConfig(userId);
      const inv = snapshot.investments as {
        total_value?: number;
        total_gain?: number;
        gain_percent?: number;
      };
      const compact = {
        period: snapshot.period,
        currency: snapshot.user.currency,
        totals: snapshot.totals,
        previous: snapshot.previous,
        twin: snapshot.twin,
        spending_by_category: snapshot.spending_by_category.slice(0, 8),
        income_by_category: snapshot.income_by_category.slice(0, 6),
        top_merchants: snapshot.top_merchants.slice(0, 6),
        budgets: {
          over_count: snapshot.budgets.over_count,
          items: (snapshot.budgets.items || []).slice(0, 6),
        },
        goals: snapshot.goals.slice(0, 6),
        loans: snapshot.loans.slice(0, 6),
        investments: {
          total_value: inv.total_value,
          total_gain: inv.total_gain,
          gain_percent: inv.gain_percent,
        },
        largest_expenses: snapshot.largest_expenses.slice(0, 8),
      };
      const result = await runProviderChat(
        config,
        [
          {
            role: 'system',
            content: `${buildSystemPrompt(masterPrompt)}

You are writing a scheduled Opal email for this user. Do not use tools, JSON action blocks, or greetings. Return 5 to 8 short paragraphs or bullets of specific, actionable financial coaching from the numbers only. Refer to categories, merchants, budgets, and goals by name. Never mention account IDs. This is decision support, not licensed advice.`,
          },
          {
            role: 'user',
            content: `Write the "what to change" section for this ${compact.period.frequency} report (${compact.period.label}). Data in ${compact.currency}:\n${JSON.stringify(compact)}`,
          },
        ],
        900,
        { maxContinuations: 1 },
      );
      const text = String(result.content || '').trim();
      return text || null;
    } catch (error: any) {
      // eslint-disable-next-line no-console
      console.warn(
        `[Opal] period insights fallback for ${userId}:`,
        error?.message || error,
      );
      return null;
    }
  }
}
