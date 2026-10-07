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

/** Non-streaming calls get a hard ceiling so a stalled upstream cannot hang a request. */
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Current Claude models reject sampling parameters such as `temperature`
 * (400). Only legacy families still accept it: claude-3* and the 4.x line up
 * to 4.6 (e.g. claude-sonnet-4-20250514, claude-haiku-4-5, claude-opus-4-6).
 */
function acceptsTemperature(model: string): boolean {
  const id = String(model || '').toLowerCase();
  if (id.startsWith('claude-3')) return true;
  const match = id.match(/^claude-[a-z]+-4(?:-(\d+))?/);
  if (!match) return false;
  const minor = match[1];
  // Bare 4.0 ids and dated 4.0 snapshots (8-digit suffix) are legacy too.
  if (!minor || minor.length >= 8) return true;
  return Number(minor) <= 6;
}

function refusalMessage(data: any): string {
  const details = data?.stop_details;
  const reason = [details?.category, details?.explanation]
    .filter(Boolean)
    .join(': ');
  return `Anthropic declined to answer this request${reason ? ` (${reason})` : ''}. Try rephrasing it.`;
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

  private requestBody(
    config: ProviderConfig,
    request: ProviderChatRequest,
    stream: boolean,
  ) {
    const model = request.model || config.model;
    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    return {
      model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      ...(acceptsTemperature(model)
        ? { temperature: request.temperature ?? 0.3 }
        : {}),
      system: system || undefined,
      messages: this.messages(request),
      ...(stream ? { stream: true } : {}),
    };
  }

  async chat(
    config: ProviderConfig,
    request: ProviderChatRequest,
  ): Promise<ProviderChatResult> {
    const apiKey = config.credentials.apiKey;
    if (!apiKey) {
      throw new BadRequestException('Anthropic API key is required.');
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify(this.requestBody(config, request, false)),
    });

    if (!res.ok) {
      throw new BadRequestException(
        `Provider error (anthropic): ${await readError(res)}`,
      );
    }
    const data = await res.json();
    if (data?.stop_reason === 'refusal') {
      throw new BadRequestException(refusalMessage(data));
    }
    const content = (data?.content || [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n')
      .trim();
    if (!content) {
      throw new BadRequestException(
        data?.stop_reason === 'max_tokens'
          ? 'Anthropic hit the output token limit before replying.'
          : 'Anthropic returned an empty response.',
      );
    }
    // max_tokens stops are reported (not annotated) so providers/index.ts can
    // issue continuation requests and stitch the reply.
    return {
      content,
      model: data?.model || request.model || config.model,
      provider: 'anthropic',
      finish_reason: data?.stop_reason || undefined,
      truncated: data?.stop_reason === 'max_tokens',
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

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal,
      body: JSON.stringify(this.requestBody(config, request, true)),
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
    let stopReason = '';
    let stopDetails: unknown = null;

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
        let json: any;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }
        if (json?.type === 'error') {
          // Mid-stream failures (e.g. overloaded_error) arrive as SSE events.
          throw new BadRequestException(
            `Provider error (anthropic): ${json?.error?.message || json?.error?.type || 'stream error'}`,
          );
        }
        if (json?.message?.model) model = String(json.message.model);
        if (json?.type === 'message_delta' && json?.delta?.stop_reason) {
          stopReason = String(json.delta.stop_reason);
          stopDetails = json.delta.stop_details ?? null;
        }
        if (json?.type === 'content_block_delta' && json?.delta?.text) {
          const delta = String(json.delta.text);
          content += delta;
          yield delta;
        }
      }
    }

    if (stopReason === 'refusal') {
      throw new BadRequestException(
        refusalMessage({ stop_details: stopDetails }),
      );
    }
    if (!content) {
      throw new BadRequestException(
        stopReason === 'max_tokens'
          ? 'Anthropic hit the output token limit before replying.'
          : 'Anthropic returned an empty response.',
      );
    }
    return {
      content,
      model,
      provider: 'anthropic',
      finish_reason: stopReason || undefined,
      truncated: stopReason === 'max_tokens',
    };
  }

  async testConnection(config: ProviderConfig) {
    try {
      // No temperature (current models reject it) and room for any thinking
      // the model does before the visible "ok".
      const result = await this.chat(config, {
        model: config.model,
        messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
        maxTokens: 1024,
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
