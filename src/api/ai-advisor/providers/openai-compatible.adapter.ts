import { BadRequestException } from '@nestjs/common';
import {
  AiProviderAdapter,
  ProviderChatRequest,
  ProviderChatResult,
  ProviderConfig,
} from './types';
import { normalizeOpenAiCompatibleUrl } from './url-guard';

async function readError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return (
      data?.error?.message ||
      data?.message ||
      data?.error ||
      `${res.status} ${res.statusText}`
    );
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

export class OpenAiCompatibleAdapter implements AiProviderAdapter {
  constructor(
    readonly id: 'openai' | 'local',
    private readonly defaultBaseUrl: string,
  ) {}

  private resolveUrl(config: ProviderConfig): string {
    if (this.id === 'openai') {
      return (config.baseUrl || this.defaultBaseUrl).replace(/\/$/, '');
    }
    return normalizeOpenAiCompatibleUrl(config.baseUrl || this.defaultBaseUrl);
  }

  private authHeaders(config: ProviderConfig): Record<string, string> {
    const apiKey =
      config.credentials.apiKey || (this.id === 'local' ? 'local' : '');
    if (this.id === 'openai' && !apiKey) {
      throw new BadRequestException('OpenAI API key is required.');
    }
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
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

  async chat(
    config: ProviderConfig,
    request: ProviderChatRequest,
  ): Promise<ProviderChatResult> {
    const base = this.resolveUrl(config);
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: this.authHeaders(config),
      body: JSON.stringify({
        model: request.model || config.model,
        messages: this.messages(request),
        temperature: request.temperature ?? 0.3,
        max_tokens: request.maxTokens ?? 2048,
      }),
    });

    if (!res.ok) {
      throw new BadRequestException(
        `Provider error (${this.id}): ${await readError(res)}`,
      );
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new BadRequestException('Provider returned an empty response.');
    }
    return {
      content: String(content),
      model: data?.model || request.model || config.model,
      provider: this.id,
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
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: this.authHeaders(config),
      signal,
      body: JSON.stringify({
        model: request.model || config.model,
        messages: this.messages(request),
        temperature: request.temperature ?? 0.3,
        max_tokens: request.maxTokens ?? 2048,
        stream: true,
      }),
    });

    if (!res.ok) {
      throw new BadRequestException(
        `Provider error (${this.id}): ${await readError(res)}`,
      );
    }
    if (!res.body) {
      throw new BadRequestException('Provider returned an empty stream.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let model = request.model || config.model;

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
        try {
          const json = JSON.parse(payload);
          if (json?.model) model = String(json.model);
          const delta = json?.choices?.[0]?.delta?.content;
          if (delta) {
            content += delta;
            yield String(delta);
          }
        } catch {
          /* ignore partial JSON */
        }
      }
    }

    if (!content) {
      throw new BadRequestException('Provider returned an empty response.');
    }
    return {
      content,
      model,
      provider: this.id,
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
        maxTokens: 16,
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
      const apiKey =
        config.credentials.apiKey || (this.id === 'local' ? 'local' : '');
      const res = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return [];
      const data = await res.json();
      const ids = (data?.data || [])
        .map((m: any) => m.id)
        .filter((id: unknown): id is string => typeof id === 'string');
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

export const localAdapter = new OpenAiCompatibleAdapter(
  'local',
  'http://127.0.0.1:11434/v1',
);
