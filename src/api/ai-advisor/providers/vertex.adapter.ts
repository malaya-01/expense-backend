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
 * and default the total high enough that long Opal answers finish.
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

/** Models whose thinking cannot be turned off (thinkingBudget 0 is rejected). */
function requiresThinking(model: string): boolean {
  const id = String(model || '').toLowerCase();
  return id.includes('2.5-pro') || id.includes('gemini-3');
}

function thinkingBudgetFor(maxOutputTokens: number, model: string): number | null {
  if (!usesThinkingModel(model)) return null;
  // Leave most of the budget for visible reply text; never exceed the output
  // budget (thinking shares maxOutputTokens).
  const budget = Math.max(
    0,
    Math.min(2048, Math.floor(maxOutputTokens * 0.12)),
  );
  return requiresThinking(model) ? Math.max(128, budget) : budget;
}

/** Non-streaming calls get a hard ceiling so a stalled upstream cannot hang a request. */
const REQUEST_TIMEOUT_MS = 120_000;

function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** The 'global' location uses the un-prefixed host. */
function vertexHost(location: string): string {
  return location === 'global'
    ? 'aiplatform.googleapis.com'
    : `${location}-aiplatform.googleapis.com`;
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
      `https://${vertexHost(location)}/v1/projects/${projectId}` +
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
      signal: withTimeout(signal),
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

  // MAX_TOKENS stops are reported via `truncated`; providers/index.ts issues
  // up to MAX_CONTINUATIONS follow-up requests and stitches/streams them.

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
    const content = extractVisibleText(data).trim();
    const finishReason = finishReasonOf(data);
    if (!content) {
      throw new BadRequestException(
        isMaxTokensStop(finishReason)
          ? 'Vertex hit the output token limit before replying.'
          : 'Vertex returned an empty response.',
      );
    }

    return {
      content,
      model,
      provider: 'vertex',
      finish_reason: finishReason || undefined,
      truncated: isMaxTokensStop(finishReason),
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

    return {
      content,
      model,
      provider: 'vertex',
      finish_reason: lastFinishReason || undefined,
      truncated: isMaxTokensStop(lastFinishReason),
    };
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
        `https://${vertexHost(location)}/v1/projects/` +
        `${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}` +
        '/publishers/google/models?pageSize=100';
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: withTimeout(),
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
