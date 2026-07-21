import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { AiSettingsService } from './ai-settings.service';
import { AiToolsService, Citation } from './ai-tools.service';
import { AiWebSearchService } from './ai-web-search.service';
import { runProviderChat, runProviderChatStream } from './providers';
import { buildSystemPrompt } from './prompts/finos-master';
import { ChatMessageDto } from './dto/ai-advisor.dto';
import { ChatMessage } from './providers/types';

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
      message: Record<string, unknown>;
      proposals: any[];
      provider: string;
      model: string;
      tool_activity: Array<{ name: string; status: string; summary: string }>;
      citations: Citation[];
      suggested_questions: string[];
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
  constructor(
    @Inject('PG_POOL')
    private readonly pgPool: Pool,
    private readonly settingsService: AiSettingsService,
    private readonly toolsService: AiToolsService,
    private readonly webSearchService: AiWebSearchService,
  ) {}

  async listConversations(userId: string, query?: string) {
    const search = query?.trim();
    const result = await this.pgPool.query(
      `SELECT id, title, provider, model, pinned_at, archived_at, last_message_preview,
              created_at, updated_at
       FROM ai_conversations
       WHERE user_id = $1
         AND deleted_at IS NULL
         AND archived_at IS NULL
         AND (
           $2::text IS NULL
           OR title ILIKE '%' || $2 || '%'
           OR COALESCE(last_message_preview, '') ILIKE '%' || $2 || '%'
         )
       ORDER BY pinned_at DESC NULLS LAST, updated_at DESC
       LIMIT 80`,
      [userId, search || null],
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
    return { id };
  }

  async renameConversation(userId: string, id: string, title: string) {
    const result = await this.pgPool.query(
      `UPDATE ai_conversations
       SET title = $3, updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING id, title, provider, model, pinned_at, archived_at, last_message_preview,
                 created_at, updated_at`,
      [id, userId, title.trim()],
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
        (user_id, title, provider, model, last_message_preview)
       VALUES ($1, $2, $3, $4, $5)
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
              ${includeContent ? ', content' : ''}
       FROM ai_documents
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [id, userId],
    );
    if (!result.rowCount) throw new NotFoundException('Document not found');
    const row = result.rows[0];
    if (includeContent && row.content) {
      row.data_base64 = Buffer.from(row.content).toString('base64');
      delete row.content;
    }
    return row;
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
    const analysis = await this.analyzeDocumentWithProvider(
      userId,
      dto.name,
      dto.mime_type,
      dto.data_base64,
      localAnalysis,
    );

    const inserted = await this.pgPool.query(
      `INSERT INTO ai_documents
        (user_id, conversation_id, name, mime_type, size_bytes, content,
         detected_type, summary, analysis_confidence, extracted_sections,
         suggested_actions, related_accounts, related_transactions, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'ready')
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
        buffer,
        analysis.detected_type,
        analysis.summary,
        analysis.analysis_confidence,
        JSON.stringify(analysis.extracted_sections),
        JSON.stringify(analysis.suggested_actions),
        JSON.stringify(analysis.related_accounts),
        JSON.stringify(analysis.related_transactions),
      ],
    );
    return inserted.rows[0];
  }

  async deleteDocument(userId: string, id: string) {
    const result = await this.pgPool.query(
      `UPDATE ai_documents
       SET deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING id`,
      [id, userId],
    );
    if (!result.rowCount) throw new NotFoundException('Document not found');
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
      'Ask FinOS to summarize this document',
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
    try {
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
        `Financial context: ${JSON.stringify(twin.context).slice(0, 16000)}`,
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
      const parsed = JSON.parse((match?.[1] || response.content).trim());
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
    } catch {
      return fallback;
    }
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

  async chat(userId: string, dto: ChatMessageDto) {
    const prepared = await this.prepareChat(userId, dto);
    const result = await runProviderChat(prepared.config, prepared.messages);
    return this.persistAssistantTurn(prepared, result.content, result.model);
  }

  async *chatStream(
    userId: string,
    dto: ChatMessageDto,
    signal?: AbortSignal,
  ): AsyncGenerator<AiChatStreamEvent> {
    try {
      yield { type: 'status', message: 'Loading provider and twin context…' };
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
      yield { type: 'status', message: 'Generating reply…' };

      let rawContent = '';
      let model = prepared.config.model;
      const stream = runProviderChatStream(
        prepared.config,
        prepared.messages,
        signal,
      );
      while (true) {
        const next = await stream.next();
        if (next.done) {
          if (next.value?.model) model = next.value.model;
          if (next.value?.content) rawContent = next.value.content;
          break;
        }
        rawContent += next.value;
        yield { type: 'delta', text: next.value };
      }

      yield { type: 'status', message: 'Preparing relevant follow-up questions…' };
      const persisted = await this.persistAssistantTurn(
        prepared,
        rawContent,
        model,
      );
      yield {
        type: 'done',
        conversation_id: persisted.conversation_id,
        message: persisted.message,
        proposals: persisted.proposals,
        provider: persisted.provider,
        model: persisted.model,
        tool_activity: persisted.tool_activity,
        citations: persisted.citations,
        suggested_questions: persisted.suggested_questions,
      };
    } catch (error: any) {
      if (signal?.aborted || error?.name === 'AbortError') {
        yield { type: 'error', message: 'Request cancelled' };
        return;
      }
      yield {
        type: 'error',
        message: error?.message || 'Advisor stream failed',
      };
    }
  }

  private async prepareChat(userId: string, dto: ChatMessageDto) {
    const { config, masterPrompt } =
      await this.settingsService.loadActiveProviderConfig(userId);

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
      const title =
        dto.content.trim().slice(0, 60) +
        (dto.content.trim().length > 60 ? '…' : '');
      const created = await this.pgPool.query(
        `INSERT INTO ai_conversations (user_id, title, provider, model)
         VALUES ($1, $2, $3, $4)
         RETURNING id, title, provider, model, created_at, updated_at`,
        [userId, title || 'New conversation', config.provider, config.model],
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

    const history = await this.pgPool.query(
      `SELECT role, content FROM ai_messages
       WHERE conversation_id = $1 AND user_id = $2 AND role IN ('user', 'assistant')
       ORDER BY created_at ASC
       LIMIT 24`,
      [conversationId, userId],
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
      await this.toolsService.gatherContext(userId);
    const useWebSearch =
      dto.web_search === true ||
      this.webSearchService.shouldSearchAutomatically(dto.content);

    if (useWebSearch) {
      if (this.webSearchService.available) {
        try {
          const web = await this.webSearchService.search(dto.content);
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
      } else if (dto.web_search) {
        activity.push({
          name: 'search_public_web',
          status: 'error',
          summary: 'Tavily is not configured',
        });
      }
    }

    const system = [
      buildSystemPrompt(masterPrompt),
      memoryEnabled
        ? [
            'Durable user memory (user-controlled; use when relevant):',
            JSON.stringify(memories.rows.map((row) => row.content)).slice(0, 12000),
            'Recent context from other conversations (oldest to newest):',
            JSON.stringify([...recentAcrossChats.rows].reverse()).slice(0, 16000),
          ].join('\n')
        : 'Cross-conversation memory is disabled by the user.',
      'Live FinOS twin context (JSON):',
      JSON.stringify({ ...context, web_sources: undefined }).slice(0, 48000),
      context.web_sources
        ? [
            'Current public web sources are included above.',
            'Use them only for public facts, clearly distinguish them from the user’s FinOS data, and cite claims with descriptive Markdown links to the supplied URLs.',
            'Never fabricate a citation or image.',
            `Public web source excerpts (JSON): ${JSON.stringify(context.web_sources).slice(0, 12000)}`,
          ].join(' ')
        : 'No live web sources were requested for this answer.',
    ].join('\n\n');

    const messages: ChatMessage[] = [
      { role: 'system' as const, content: system },
      ...history.rows.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: String(m.content),
      })),
    ];
    if (dto.attachments?.length) {
      messages[messages.length - 1].attachments = dto.attachments.map((file) => ({
        name: file.name,
        mimeType: file.mime_type,
        dataBase64: file.data_base64,
      }));
    }

    return {
      userId,
      config,
      conversationId: conversationId as string,
      userPrompt: dto.content.trim(),
      messages,
      context,
      activity,
      citations,
    };
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
      messages: ChatMessage[];
      context: Record<string, unknown>;
      activity: Array<{ name: string; status: string; summary: string }>;
      citations: Citation[];
    },
    rawContent: string,
    model: string,
  ) {
    const parsed = this.extractProposals(rawContent);
    const cleanContent = parsed.cleanedContent;
    const userId = prepared.userId;

    const proposalIds: string[] = [];
    const proposalRows: any[] = [];
    for (const proposal of parsed.proposals) {
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

    const suggestedQuestions = await this.generateSuggestedQuestions(
      prepared.config,
      prepared.userPrompt,
      cleanContent,
      prepared.context,
    );

    return {
      conversation_id: prepared.conversationId,
      message: assistant.rows[0],
      proposals: proposalRows,
      provider: prepared.config.provider,
      model,
      tool_activity: prepared.activity,
      citations: prepared.citations,
      suggested_questions: suggestedQuestions,
    };
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
      const result = await runProviderChat(config, [
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
      ]);

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
    const client = await this.pgPool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT * FROM ai_action_proposals
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [proposalId, userId],
      );
      if (!result.rowCount) {
        throw new NotFoundException('Proposal not found');
      }
      const row = result.rows[0];
      if (row.status !== 'pending') {
        throw new BadRequestException(`Proposal is already ${row.status}`);
      }
      if (new Date(row.expires_at) < new Date()) {
        await client.query(
          `UPDATE ai_action_proposals SET status = 'expired', updated_at = NOW() WHERE id = $1`,
          [proposalId],
        );
        await client.query('COMMIT');
        throw new BadRequestException('Proposal expired. Ask FinOS again.');
      }

      const executed = await this.toolsService.executeProposal(
        userId,
        row.action_type,
        row.payload || {},
      );

      await client.query(
        `UPDATE ai_action_proposals
         SET status = 'confirmed', executed_at = NOW(), result = $2, updated_at = NOW()
         WHERE id = $1`,
        [proposalId, JSON.stringify(executed)],
      );
      await client.query('COMMIT');
      return {
        id: proposalId,
        status: 'confirmed',
        result: executed,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }
      await this.pgPool.query(
        `UPDATE ai_action_proposals
         SET status = 'failed', result = $2, updated_at = NOW()
         WHERE id = $1 AND user_id = $3`,
        [
          proposalId,
          JSON.stringify({ error: (error as Error).message }),
          userId,
        ],
      );
      throw new BadRequestException(
        (error as Error).message || 'Failed to execute proposal',
      );
    } finally {
      client.release();
    }
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
    const cleanedContent = content.replace(
      /```action_proposal\s*([\s\S]*?)```/gi,
      (_match, json) => {
        try {
          const parsed = JSON.parse(String(json).trim());
          if (parsed?.action_type && parsed?.title) {
            proposals.push({
              action_type: String(parsed.action_type),
              title: String(parsed.title),
              summary: parsed.summary ? String(parsed.summary) : undefined,
              payload:
                typeof parsed.payload === 'object' && parsed.payload
                  ? parsed.payload
                  : {},
            });
          }
        } catch {
          /* ignore malformed */
        }
        return '';
      },
    );
    return { cleanedContent: cleanedContent.trim(), proposals };
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
}
