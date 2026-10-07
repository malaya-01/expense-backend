import { BadRequestException } from '@nestjs/common';
import appConfiguration from 'src/app.configuration';
import {
  AiProviderAdapter,
  DEFAULT_MAX_OUTPUT_TOKENS,
  ProviderChatRequest,
  ProviderChatResult,
  ProviderConfig,
} from './types';
import { providerHttpException } from './provider-errors';
import { normalizeOpenAiCompatibleUrl } from './url-guard';
import { isTruncationReason } from './continuation';

type CompatibleProviderId = 'openai' | 'local' | 'openrouter';

async function readErrorPayload(res: Response): Promise<{
  message: string;
  code?: string;
}> {
  try {
    const data = await res.json();
    const message =
      data?.error?.message ||
      data?.message ||
      (typeof data?.error === 'string' ? data.error : null) ||
      `${res.status} ${res.statusText}`;
    const code =
      data?.error?.code ||
      data?.error?.metadata?.raw ||
      data?.code ||
      undefined;
    return {
      message: String(message),
      code: code ? String(code) : undefined,
    };
  } catch {
    return { message: `${res.status} ${res.statusText}` };
  }
}

function throwProviderFailure(
  provider: CompatibleProviderId,
  res: Response,
  payload: { message: string; code?: string },
): never {
  const combined = [payload.code, payload.message].filter(Boolean).join(' — ');
  throw providerHttpException(provider, res.status, combined);
}

/** Non-streaming calls get a hard ceiling so a stalled upstream cannot hang a request. */
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * OpenAI reasoning models (o1/o3/o4…, gpt-5*) reject `max_tokens` and any
 * non-default `temperature`; they take `max_completion_tokens` instead.
 */
function isReasoningModel(model: string): boolean {
  const id = String(model || '').toLowerCase().replace(/^.*\//, '');
  return /^(o\d|gpt-5)/.test(id);
}

export class OpenAiCompatibleAdapter implements AiProviderAdapter {
  constructor(
    readonly id: CompatibleProviderId,
    private readonly defaultBaseUrl: string,
  ) {}

  private resolveUrl(config: ProviderConfig): string {
    if (this.id === 'openrouter') {
      return (config.baseUrl || this.defaultBaseUrl).replace(/\/$/, '');
    }
    if (this.id === 'openai') {
      return (config.baseUrl || this.defaultBaseUrl).replace(/\/$/, '');
    }
    return normalizeOpenAiCompatibleUrl(config.baseUrl || this.defaultBaseUrl);
  }

  private authHeaders(config: ProviderConfig): Record<string, string> {
    const apiKey =
      config.credentials.apiKey || (this.id === 'local' ? 'local' : '');
    if ((this.id === 'openai' || this.id === 'openrouter') && !apiKey) {
      throw new BadRequestException(
        `${this.id === 'openrouter' ? 'OpenRouter' : 'OpenAI'} API key is required.`,
      );
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
    if (this.id === 'openrouter') {
      const cfg = appConfiguration();
      headers['HTTP-Referer'] = cfg.CLIENT_HOST || 'https://opal.app';
      headers['X-OpenRouter-Title'] = cfg.PROJECT || 'Opal';
    }
    return headers;
  }

  private messages(request: ProviderChatRequest) {
    return request.messages.map((message) => {
      const role = message.role === 'tool' ? 'assistant' : message.role;
      if (!message.attachments?.length) return { role, content: message.content };

      const content: any[] = [{ type: 'text', text: message.content }];
      for (const file of message.attachments) {
        if (file.mimeType === 'application/pdf') {
          throw new BadRequestException(
            `${this.id} chat attachments currently support images and text files, not PDF. Use Vertex or Anthropic for PDFs.`,
          );
        }
        if (
          file.mimeType.startsWith('text/') ||
          file.mimeType === 'application/json'
        ) {
          content.push({
            type: 'text',
            text: `Attached file ${file.name}:\n${Buffer.from(file.dataBase64, 'base64').toString('utf8')}`,
          });
        } else {
          content.push({
            type: 'image_url',
            image_url: {
              url: `data:${file.mimeType};base64,${file.dataBase64}`,
            },
          });
        }
      }
      return { role, content };
    });
  }

  private samplingParams(model: string, request: ProviderChatRequest) {
    const maxTokens = request.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    if (isReasoningModel(model)) {
      return { max_completion_tokens: maxTokens };
    }
    return {
      temperature: request.temperature ?? 0.3,
      max_tokens: maxTokens,
    };
  }

  async chat(
    config: ProviderConfig,
    request: ProviderChatRequest,
  ): Promise<ProviderChatResult> {
    const base = this.resolveUrl(config);
    const model = request.model || config.model;
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: this.authHeaders(config),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        messages: this.messages(request),
        ...this.samplingParams(model, request),
      }),
    });

    if (!res.ok) {
      throwProviderFailure(this.id, res, await readErrorPayload(res));
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    const finishReason = data?.choices?.[0]?.finish_reason;
    if (!content) {
      throw new BadRequestException(
        isTruncationReason(finishReason)
          ? 'Provider hit the output token limit before replying.'
          : 'Provider returned an empty response.',
      );
    }
    return {
      content: String(content),
      model: data?.model || request.model || config.model,
      provider: this.id,
      finish_reason: finishReason ? String(finishReason) : undefined,
      truncated: isTruncationReason(finishReason),
      usage: {
        input_tokens: data?.usage?.prompt_tokens,
        output_tokens: data?.usage?.completion_tokens,
      },
    };
  }

  async *streamChat(
    config: ProviderConfig,
    request: ProviderChatRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<string, ProviderChatResult, void> {
    const base = this.resolveUrl(config);
    const requestModel = request.model || config.model;
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: this.authHeaders(config),
      signal,
      body: JSON.stringify({
        model: requestModel,
        messages: this.messages(request),
        ...this.samplingParams(requestModel, request),
        stream: true,
      }),
    });

    if (!res.ok) {
      throwProviderFailure(this.id, res, await readErrorPayload(res));
    }
    if (!res.body) {
      throw new BadRequestException('Provider returned an empty stream.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let model = requestModel;
    let finishReason = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let json: any;
        try {
          json = JSON.parse(payload);
        } catch {
          continue; /* ignore partial JSON */
        }
        if (json?.error) {
          // OpenRouter / OpenAI report mid-stream failures as an error frame.
          const message =
            (typeof json.error === 'string' ? json.error : json.error?.message) ||
            'stream error';
          throw new BadRequestException(`Provider error (${this.id}): ${message}`);
        }
        if (json?.model) model = String(json.model);
        const reason = json?.choices?.[0]?.finish_reason;
        if (reason) finishReason = String(reason);
        const delta = json?.choices?.[0]?.delta?.content;
        if (delta) {
          content += delta;
          yield String(delta);
        }
      }
    }

    if (!content) {
      throw new BadRequestException(
        isTruncationReason(finishReason)
          ? 'Provider hit the output token limit before replying.'
          : 'Provider returned an empty response.',
      );
    }
    return {
      content,
      model,
      provider: this.id,
      finish_reason: finishReason || undefined,
      truncated: isTruncationReason(finishReason),
    };
  }

  async testConnection(config: ProviderConfig) {
    try {
      const result = await this.chat(config, {
        model: config.model,
        messages: [
          {
            role: 'user',
            content: 'Reply with exactly: ok',
          },
        ],
        // Reasoning models spend completion tokens on hidden reasoning first.
        maxTokens: isReasoningModel(config.model) ? 1024 : 16,
        temperature: 0,
      });
      return {
        ok: true,
        message: `Connected to ${this.id} (${result.model}).`,
        model: result.model,
      };
    } catch (error: any) {
      return {
        ok: false,
        message: error?.message || 'Connection failed',
      };
    }
  }

  async listModels(config: ProviderConfig): Promise<string[]> {
    try {
      const base = this.resolveUrl(config);
      const res = await fetch(`${base}/models`, {
        headers: this.authHeaders(config),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) return [];
      const data = await res.json();
      const ids = (data?.data || [])
        .map((m: any) => m.id)
        .filter((id: unknown): id is string => typeof id === 'string');

      if (this.id === 'openrouter') {
        // Prefer free / popular chat models; curated defaults are merged upstream.
        const freeFirst = [...ids].sort((a, b) => {
          const aFree = a.includes(':free') ? 0 : 1;
          const bFree = b.includes(':free') ? 0 : 1;
          if (aFree !== bFree) return aFree - bFree;
          return a.localeCompare(b);
        });
        return freeFirst.slice(0, 120);
      }
      return ids.slice(0, 50);
    } catch {
      return [];
    }
  }
}

export const openAiAdapter = new OpenAiCompatibleAdapter(
  'openai',
  'https://api.openai.com/v1',
);

export const openRouterAdapter = new OpenAiCompatibleAdapter(
  'openrouter',
  'https://openrouter.ai/api/v1',
);

export const localAdapter = new OpenAiCompatibleAdapter(
  'local',
  'http://127.0.0.1:11434/v1',
);
