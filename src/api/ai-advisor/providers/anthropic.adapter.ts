import { BadRequestException } from '@nestjs/common';
import {
  AiProviderAdapter,
  DEFAULT_MAX_OUTPUT_TOKENS,
  ProviderChatRequest,
  ProviderChatResult,
  ProviderConfig,
} from './types';

async function readError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return data?.error?.message || data?.message || `${res.status} ${res.statusText}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

export class AnthropicAdapter implements AiProviderAdapter {
  readonly id = 'anthropic' as const;

  private messages(request: ProviderChatRequest) {
    return request.messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => {
        if (!message.attachments?.length) {
          return { role: message.role, content: message.content };
        }
        const content: any[] = [{ type: 'text', text: message.content }];
        for (const file of message.attachments) {
          if (
            file.mimeType.startsWith('text/') ||
            file.mimeType === 'application/json'
          ) {
            content.push({
              type: 'text',
              text: `Attached file ${file.name}:\n${Buffer.from(file.dataBase64, 'base64').toString('utf8')}`,
            });
          } else if (file.mimeType === 'application/pdf') {
            content.push({
              type: 'document',
              source: {
                type: 'base64',
                media_type: file.mimeType,
                data: file.dataBase64,
              },
            });
          } else {
            content.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: file.mimeType,
                data: file.dataBase64,
              },
            });
          }
        }
        return { role: message.role, content };
      });
  }

  async chat(
    config: ProviderConfig,
    request: ProviderChatRequest,
  ): Promise<ProviderChatResult> {
    const apiKey = config.credentials.apiKey;
    if (!apiKey) {
      throw new BadRequestException('Anthropic API key is required.');
    }

    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const messages = this.messages(request);

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: request.model || config.model,
        max_tokens: request.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        temperature: request.temperature ?? 0.3,
        system: system || undefined,
        messages,
      }),
    });

    if (!res.ok) {
      throw new BadRequestException(
        `Provider error (anthropic): ${await readError(res)}`,
      );
    }
    const data = await res.json();
    const content = (data?.content || [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n')
      .trim();
    if (!content) {
      throw new BadRequestException('Anthropic returned an empty response.');
    }
    return {
      content,
      model: data?.model || request.model || config.model,
      provider: 'anthropic',
      usage: {
        input_tokens: data?.usage?.input_tokens,
        output_tokens: data?.usage?.output_tokens,
      },
    };
  }

  async *streamChat(
    config: ProviderConfig,
    request: ProviderChatRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<string, ProviderChatResult, void> {
    const apiKey = config.credentials.apiKey;
    if (!apiKey) {
      throw new BadRequestException('Anthropic API key is required.');
    }

    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const messages = this.messages(request);

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal,
      body: JSON.stringify({
        model: request.model || config.model,
        max_tokens: request.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        temperature: request.temperature ?? 0.3,
        system: system || undefined,
        messages,
        stream: true,
      }),
    });

    if (!res.ok) {
      throw new BadRequestException(
        `Provider error (anthropic): ${await readError(res)}`,
      );
    }
    if (!res.body) {
      throw new BadRequestException('Anthropic returned an empty stream.');
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
        if (!payload) continue;
        try {
          const json = JSON.parse(payload);
          if (json?.message?.model) model = String(json.message.model);
          if (json?.type === 'content_block_delta' && json?.delta?.text) {
            const delta = String(json.delta.text);
            content += delta;
            yield delta;
          }
        } catch {
          /* ignore */
        }
      }
    }

    if (!content) {
      throw new BadRequestException('Anthropic returned an empty response.');
    }
    return { content, model, provider: 'anthropic' };
  }

  async testConnection(config: ProviderConfig) {
    try {
      const result = await this.chat(config, {
        model: config.model,
        messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
        maxTokens: 16,
        temperature: 0,
      });
      return {
        ok: true,
        message: `Connected to Anthropic (${result.model}).`,
        model: result.model,
      };
    } catch (error: any) {
      return { ok: false, message: error?.message || 'Connection failed' };
    }
  }
}

export const anthropicAdapter = new AnthropicAdapter();
