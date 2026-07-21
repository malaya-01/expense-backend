import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { AiSettingsService } from './ai-settings.service';
import { AiToolsService } from './ai-tools.service';
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
      citations: Array<{ label: string; href: string }>;
    }
  | {
      type: 'done';
      conversation_id: string;
      message: Record<string, unknown>;
      proposals: any[];
      provider: string;
      model: string;
      tool_activity: Array<{ name: string; status: string; summary: string }>;
      citations: Array<{ label: string; href: string }>;
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
  ) {}

  async listConversations(userId: string) {
    const result = await this.pgPool.query(
      `SELECT id, title, provider, model, created_at, updated_at
       FROM ai_conversations
       WHERE user_id = $1 AND deleted_at IS NULL
       ORDER BY updated_at DESC
       LIMIT 40`,
      [userId],
    );
    return result.rows;
  }

  async getConversation(userId: string, id: string) {
    const conv = await this.pgPool.query(
      `SELECT id, title, provider, model, created_at, updated_at
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
      JSON.stringify(context).slice(0, 48000),
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
      context: Record<string, unknown>;
      activity: Array<{ name: string; status: string; summary: string }>;
      citations: Array<{ label: string; href: string }>;
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
       SET updated_at = NOW(), provider = $3, model = $4
       WHERE id = $1 AND user_id = $2`,
      [prepared.conversationId, userId, prepared.config.provider, model],
    );

    return {
      conversation_id: prepared.conversationId,
      message: assistant.rows[0],
      proposals: proposalRows,
      provider: prepared.config.provider,
      model,
      tool_activity: prepared.activity,
      citations: prepared.citations,
      suggested_questions: this.suggestedQuestions(prepared.context),
    };
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

  private suggestedQuestions(context: Record<string, unknown>): string[] {
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
