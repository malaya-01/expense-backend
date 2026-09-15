import { BadRequestException } from '@nestjs/common';
import { GoogleAuth } from 'google-auth-library';
import {
  AiProviderAdapter,
  DEFAULT_MAX_OUTPUT_TOKENS,
  ProviderChatRequest,
  ProviderChatResult,
  ProviderConfig,
} from './types';

/**
 * Vertex / Gemini advisor replies need a large visible-token budget.
 * Gemini 2.5+ "thinking" shares maxOutputTokens — keep thinking modest
 * and default the total high enough that long FinOS answers finish.
 */
export const VERTEX_MAX_OUTPUT_TOKENS = Math.min(
  Math.max(
    Number(process.env.VERTEX_MAX_OUTPUT_TOKENS || DEFAULT_MAX_OUTPUT_TOKENS),
    8192,
  ),
  65536,
);

function usesThinkingModel(model: string): boolean {
  const id = String(model || '').toLowerCase();
  return (
    id.includes('2.5') ||
    id.includes('gemini-3') ||
    id.includes('thinking')
  );
}

function resolveMaxOutputTokens(request: ProviderChatRequest): number {
  const requested = Number(request.maxTokens || 0);
  if (Number.isFinite(requested) && requested > 0) {
    return Math.min(Math.max(requested, 256), 65536);
  }
  return VERTEX_MAX_OUTPUT_TOKENS;
}

function thinkingBudgetFor(maxOutputTokens: number, model: string): number | null {
  if (!usesThinkingModel(model)) return null;
  // Leave most of the budget for visible reply text.
  return Math.min(2048, Math.max(512, Math.floor(maxOutputTokens * 0.12)));
}

function extractVisibleText(data: unknown): string {
  const parts =
    (data as { candidates?: Array<{ content?: { parts?: unknown[] } }> })
      ?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((part: any) => part && !part.thought)
    .map((part: any) => part.text || '')
    .join('');
}

function finishReasonOf(data: unknown): string {
  return String(
    (data as { candidates?: Array<{ finishReason?: string }> })?.candidates?.[0]
      ?.finishReason || '',
  ).toUpperCase();
}

function isMaxTokensStop(reason: string): boolean {
  return reason === 'MAX_TOKENS' || reason === 'LENGTH';
}

export class VertexAdapter implements AiProviderAdapter {
  readonly id = 'vertex' as const;

  private async getAccessToken(serviceAccountJson: string): Promise<string> {
    let credentials: Record<string, unknown>;
    try {
      credentials = JSON.parse(serviceAccountJson);
    } catch {
      throw new BadRequestException('Vertex service-account JSON is invalid.');
    }
    if (!credentials.client_email || !credentials.private_key) {
      throw new BadRequestException(
        'Service-account JSON must include client_email and private_key.',
      );
    }
    const auth = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const client = await auth.getClient();
    const token = await client.getAccessToken();
    if (!token?.token) {
      throw new BadRequestException('Could not obtain Vertex access token.');
    }
    return token.token;
  }

  private requestBody(request: ProviderChatRequest) {
    const model = request.model || '';
    const maxOutputTokens = resolveMaxOutputTokens(request);
    const thinkingBudget = thinkingBudgetFor(maxOutputTokens, model);
    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const contents = request.messages
      .filter(
        (message) =>
          message.role === 'user' || message.role === 'assistant',
      )
      .map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [
          { text: message.content },
          ...(message.attachments || []).map((file) => ({
            inlineData: {
              mimeType: file.mimeType,
              data: file.dataBase64,
            },
          })),
        ],
      }));
    return {
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents,
      generationConfig: {
        temperature: request.temperature ?? 0.3,
        maxOutputTokens,
        ...(thinkingBudget != null
          ? {
              thinkingConfig: {
                thinkingBudget,
                includeThoughts: false,
              },
            }
          : {}),
      },
    };
  }

  private resolveProject(config: ProviderConfig, serviceAccountJson: string) {
    const projectId =
      config.projectId ||
      config.credentials.projectId ||
      (() => {
        try {
          return JSON.parse(serviceAccountJson).project_id as string;
        } catch {
          return '';
        }
      })();
    if (!projectId) {
      throw new BadRequestException('Vertex project id is required.');
    }
    return {
      projectId,
      location:
        config.location || config.credentials.location || 'us-central1',
    };
  }

  private endpoint(
    projectId: string,
    location: string,
    model: string,
    stream: boolean,
  ) {
    const base =
      `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}` +
      `/locations/${location}/publishers/google/models/${model}`;
    return stream
      ? `${base}:streamGenerateContent?alt=sse`
      : `${base}:generateContent`;
  }

  private async generateOnce(
    url: string,
    accessToken: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      signal,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const err = await res.json();
        message = err?.error?.message || message;
      } catch {
        /* ignore */
      }
      throw new BadRequestException(`Provider error (vertex): ${message}`);
    }
    return res.json();
  }

  /**
   * If Vertex stopped early on MAX_TOKENS, ask once to continue so long
   * advisor answers are not left mid-sentence.
   */
  private async continueIfTruncated(
    url: string,
    accessToken: string,
    request: ProviderChatRequest,
    partial: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const continuationRequest: ProviderChatRequest = {
      ...request,
      messages: [
        ...request.messages,
        { role: 'assistant', content: partial },
        {
          role: 'user',
          content:
            'Continue the previous reply from exactly where it stopped. Do not restart or repeat earlier text — only finish the remaining answer.',
        },
      ],
      // Fresh budget for the continuation segment.
      maxTokens: Math.max(4096, Math.floor(resolveMaxOutputTokens(request) / 2)),
    };
    const data = await this.generateOnce(
      url,
      accessToken,
      this.requestBody(continuationRequest),
      signal,
    );
    return extractVisibleText(data).trim();
  }

  async chat(
    config: ProviderConfig,
    request: ProviderChatRequest,
  ): Promise<ProviderChatResult> {
    const sa = config.credentials.serviceAccountJson;
    if (!sa) {
      throw new BadRequestException('Vertex service-account JSON is required.');
    }
    const { projectId, location } = this.resolveProject(config, sa);
    const accessToken = await this.getAccessToken(sa);
    const model = request.model || config.model;
    const url = this.endpoint(projectId, location, model, false);

    const data = await this.generateOnce(
      url,
      accessToken,
      this.requestBody({ ...request, model }),
    );
    let content = extractVisibleText(data).trim();
    if (!content) {
      throw new BadRequestException('Vertex returned an empty response.');
    }

    if (isMaxTokensStop(finishReasonOf(data))) {
      const more = await this.continueIfTruncated(
        url,
        accessToken,
        { ...request, model },
        content,
      ).catch(() => '');
      if (more) content = `${content}${more.startsWith('\n') ? '' : '\n'}${more}`.trim();
    }

    return {
      content,
      model,
      provider: 'vertex',
      usage: {
        input_tokens: (data as any)?.usageMetadata?.promptTokenCount,
        output_tokens: (data as any)?.usageMetadata?.candidatesTokenCount,
      },
    };
  }

  async *streamChat(
    config: ProviderConfig,
    request: ProviderChatRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<string, ProviderChatResult, void> {
    const sa = config.credentials.serviceAccountJson;
    if (!sa) {
      throw new BadRequestException('Vertex service-account JSON is required.');
    }
    const { projectId, location } = this.resolveProject(config, sa);
    const accessToken = await this.getAccessToken(sa);
    const model = request.model || config.model;
    const url = this.endpoint(projectId, location, model, true);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      signal,
      body: JSON.stringify(this.requestBody({ ...request, model })),
    });
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const error = await res.json();
        message = error?.error?.message || message;
      } catch {
        /* ignore */
      }
      throw new BadRequestException(`Provider error (vertex): ${message}`);
    }
    if (!res.body) {
      throw new BadRequestException('Vertex returned an empty stream.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let lastFinishReason = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        try {
          const data = JSON.parse(line.slice(5).trim());
          const reason = finishReasonOf(data);
          if (reason) lastFinishReason = reason;
          const delta = extractVisibleText(data);
          if (delta) {
            content += delta;
            yield delta;
          }
        } catch {
          /* wait for the next complete SSE frame */
        }
      }
    }
    if (!content) {
      throw new BadRequestException('Vertex returned an empty response.');
    }

    if (isMaxTokensStop(lastFinishReason) && !signal?.aborted) {
      const continueUrl = this.endpoint(projectId, location, model, false);
      const more = await this.continueIfTruncated(
        continueUrl,
        accessToken,
        { ...request, model },
        content,
        signal,
      ).catch(() => '');
      if (more) {
        const glue = more.startsWith('\n') ? '' : '\n';
        content += `${glue}${more}`;
        yield `${glue}${more}`;
      }
    }

    return { content, model, provider: 'vertex' };
  }

  async testConnection(config: ProviderConfig) {
    try {
      const result = await this.chat(config, {
        model: config.model,
        messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
        // Gemini 2.5 may consume a small token budget for internal reasoning
        // before emitting text, so a 16-token health check can look empty.
        maxTokens: 256,
        temperature: 0,
      });
      return {
        ok: true,
        message: `Connected to Vertex AI (${result.model}).`,
        model: result.model,
      };
    } catch (error: any) {
      return { ok: false, message: error?.message || 'Connection failed' };
    }
  }

  async listModels(config: ProviderConfig): Promise<string[]> {
    const sa = config.credentials.serviceAccountJson;
    if (!sa) return [];
    const credentials = JSON.parse(sa) as { project_id?: string };
    const projectId =
      config.projectId || config.credentials.projectId || credentials.project_id;
    const location =
      config.location || config.credentials.location || 'us-central1';
    if (!projectId) return [];

    try {
      const token = await this.getAccessToken(sa);
      const url =
        `https://${location}-aiplatform.googleapis.com/v1/projects/` +
        `${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}` +
        '/publishers/google/models?pageSize=100';
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return [];
      const data = await res.json();
      return (data?.publisherModels || data?.models || [])
        .map((item: any) => String(item?.name || item?.displayName || ''))
        .map((name: string) => name.split('/').pop() || '')
        .filter((name: string) => name.startsWith('gemini-'))
        .map((name: string) => name.replace(/@.+$/, ''))
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}

export const vertexAdapter = new VertexAdapter();
