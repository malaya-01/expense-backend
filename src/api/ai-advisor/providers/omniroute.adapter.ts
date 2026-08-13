import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import {
  AiProviderAdapter,
  DEFAULT_MAX_OUTPUT_TOKENS,
  ProviderChatRequest,
  ProviderChatResult,
  ProviderConfig,
} from './types';
import {
  FreeBackend,
  OMNIROUTE_FREE_MODELS,
  resolveFreeBackends,
} from './omniroute.free-backends';

async function readErrorText(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return (
      data?.error?.message ||
      data?.message ||
      (typeof data?.error === 'string' ? data.error : null) ||
      `${res.status} ${res.statusText}`
    );
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

function buildMessages(request: ProviderChatRequest) {
  return request.messages.map((message) => {
    const role = message.role === 'tool' ? 'assistant' : message.role;
    if (!message.attachments?.length) {
      return { role, content: message.content };
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
      } else if (file.mimeType.startsWith('image/')) {
        content.push({
          type: 'image_url',
          image_url: {
            url: `data:${file.mimeType};base64,${file.dataBase64}`,
          },
        });
      } else {
        content.push({
          type: 'text',
          text: `[Attachment ${file.name} (${file.mimeType}) omitted for free-tier routing]`,
        });
      }
    }
    return { role, content };
  });
}

function headersFor(backend: FreeBackend): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (!backend.noAuth) {
    headers.Authorization = `Bearer ${backend.apiKey || 'omniroute'}`;
  }
  return headers;
}

async function chatOnce(
  backend: FreeBackend,
  request: ProviderChatRequest,
  signal?: AbortSignal,
): Promise<ProviderChatResult> {
  const res = await fetch(backend.chatUrl, {
    method: 'POST',
    headers: headersFor(backend),
    signal,
    body: JSON.stringify({
      model: backend.upstreamModel,
      messages: buildMessages(request),
      temperature: request.temperature ?? 0.3,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      stream: false,
    }),
  });

  if (!res.ok) {
    throw new Error(`${backend.label}: ${await readErrorText(res)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content || !String(content).trim()) {
    throw new Error(`${backend.label}: empty response`);
  }

  return {
    content: String(content),
    model: `${backend.id}/${data?.model || backend.upstreamModel}`,
    provider: 'omniroute',
    usage: {
      input_tokens: data?.usage?.prompt_tokens,
      output_tokens: data?.usage?.completion_tokens,
    },
  };
}

/**
 * Built-in OmniRoute-style free provider: no user API key.
 * Tries free no-auth backends in priority order and fails over mid-request.
 */
export class OmnirouteAdapter implements AiProviderAdapter {
  readonly id = 'omniroute' as const;

  async chat(
    config: ProviderConfig,
    request: ProviderChatRequest,
  ): Promise<ProviderChatResult> {
    const backends = resolveFreeBackends(request.model || config.model);
    if (!backends.length) {
      throw new BadRequestException(
        'No free OmniRoute backends are configured.',
      );
    }

    const errors: string[] = [];
    for (const backend of backends) {
      try {
        return await chatOnce(backend, request);
      } catch (err: any) {
        errors.push(err?.message || String(err));
      }
    }

    throw new HttpException(
      {
        statusCode: HttpStatus.BAD_GATEWAY,
        message:
          'All free OmniRoute backends failed. Try again shortly, switch model, or connect your own BYOK provider.',
        errors: errors.slice(0, 5),
        provider: 'omniroute',
      },
      HttpStatus.BAD_GATEWAY,
    );
  }

  async *streamChat(
    config: ProviderConfig,
    request: ProviderChatRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<string, ProviderChatResult, void> {
    // Free public gateways often break SSE; use non-stream chat then soft-stream.
    const result = await this.chat(config, { ...request });
    if (signal?.aborted) throw new Error('Request cancelled');
    const chunkSize = 12;
    for (let i = 0; i < result.content.length; i += chunkSize) {
      if (signal?.aborted) throw new Error('Request cancelled');
      yield result.content.slice(i, i + chunkSize);
    }
    return result;
  }

  async testConnection(
    config: ProviderConfig,
  ): Promise<{ ok: boolean; message: string; model?: string }> {
    try {
      const result = await this.chat(config, {
        model: config.model || 'auto',
        messages: [
          {
            role: 'user',
            content: 'Reply with exactly: ok',
          },
        ],
        maxTokens: 16,
      });
      return {
        ok: true,
        message: `Connected via free OmniRoute routing (${result.model}).`,
        model: result.model,
      };
    } catch (err: any) {
      return {
        ok: false,
        message: err?.message || 'Free OmniRoute backends unreachable.',
      };
    }
  }

  async listModels(): Promise<string[]> {
    return [...OMNIROUTE_FREE_MODELS];
  }
}

export const omnirouteAdapter = new OmnirouteAdapter();
