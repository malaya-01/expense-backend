import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import appConfiguration from 'src/app.configuration';
import {
  AiProviderAdapter,
  DEFAULT_MAX_OUTPUT_TOKENS,
  ProviderChatRequest,
  ProviderChatResult,
  ProviderConfig,
  ChatMessage,
} from './types';
import {
  FreeBackend,
  OMNIROUTE_FREE_MODELS,
  resolveFreeBackends,
} from './omniroute.free-backends';
import { buildLocalOpalReply } from './opal-local-reply';

export type OmnirouteProgress = (message: string) => void;

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

const OPAL_VOICE_PREFIX = `You are Opal Advisor — the built-in intelligence of Opal (the Personal Financial Operating System). You are not ChatGPT, Claude, Gemini, or any outside chatbot. Speak only as Opal: warm, calm, first-person product voice. Never say you are a language model from another company. Prefer Opal screen names and Markdown links like [Accounts](/accounts).`;

function withOpalIdentity(messages: ChatMessage[]): ChatMessage[] {
  const cloned = messages.map((m) => ({ ...m }));
  const systemIdx = cloned.findIndex((m) => m.role === 'system');
  if (systemIdx >= 0) {
    cloned[systemIdx] = {
      ...cloned[systemIdx],
      content: `${OPAL_VOICE_PREFIX}\n\n${cloned[systemIdx].content}`,
    };
    return cloned;
  }
  return [{ role: 'system', content: OPAL_VOICE_PREFIX }, ...cloned];
}

function buildOpenAiMessages(messages: ChatMessage[]) {
  return messages.map((message) => {
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
      }
    }
    return { role, content };
  });
}

function flattenForGet(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      parts.push(`System (Opal Advisor):\n${m.content.slice(0, 1200)}`);
    } else if (m.role === 'user') {
      parts.push(`User:\n${m.content}`);
    } else if (m.role === 'assistant') {
      parts.push(`Opal Advisor:\n${m.content.slice(0, 800)}`);
    }
  }
  parts.push('Opal Advisor:');
  return parts.join('\n\n').slice(0, 3500);
}

function headersFor(backend: FreeBackend): Record<string, string> {
  const cfg = appConfiguration();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'OpalAdvisor/1.0',
  };
  if (!backend.noAuth && backend.apiKey) {
    headers.Authorization = `Bearer ${backend.apiKey}`;
  }
  if (backend.chatUrl?.includes('openrouter.ai')) {
    const origin = String(cfg.CLIENT_HOST || 'https://opal.app')
      .split(',')[0]
      .trim();
    headers['HTTP-Referer'] = origin || 'https://opal.app';
    headers['X-Title'] = cfg.PROJECT || 'Opal';
  }
  return headers;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function chatOpenAiPost(
  backend: FreeBackend,
  request: ProviderChatRequest,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<ProviderChatResult> {
  if (!backend.chatUrl) throw new Error(`${backend.label}: missing URL`);
  const res = await fetchWithTimeout(
    backend.chatUrl,
    {
      method: 'POST',
      headers: headersFor(backend),
      body: JSON.stringify({
        model: backend.upstreamModel,
        messages: buildOpenAiMessages(messages),
        temperature: request.temperature ?? 0.35,
        max_tokens: Math.min(
          request.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          4096,
        ),
        stream: false,
      }),
    },
    backend.timeoutMs || 45_000,
    signal,
  );

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

async function chatPollinationsGet(
  backend: FreeBackend,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<ProviderChatResult> {
  const prompt = flattenForGet(messages);
  const url = `${backend.chatUrl}/${encodeURIComponent(prompt)}?model=${encodeURIComponent(backend.upstreamModel)}&private=false`;
  const res = await fetchWithTimeout(
    url,
    {
      method: 'GET',
      headers: {
        Accept: 'text/plain',
        'User-Agent': 'OpalAdvisor/1.0',
      },
    },
    backend.timeoutMs || 45_000,
    signal,
  );
  if (!res.ok) {
    throw new Error(`${backend.label}: ${await readErrorText(res)}`);
  }
  const content = (await res.text()).trim();
  if (!content) throw new Error(`${backend.label}: empty response`);
  return {
    content,
    model: `${backend.id}/${backend.upstreamModel}`,
    provider: 'omniroute',
  };
}

async function chatOnce(
  backend: FreeBackend,
  request: ProviderChatRequest,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<ProviderChatResult> {
  if (backend.kind === 'local_opal') {
    return {
      content: buildLocalOpalReply(messages),
      model: 'omniroute/opal-local',
      provider: 'omniroute',
    };
  }
  if (backend.kind === 'pollinations_get') {
    return chatPollinationsGet(backend, messages, signal);
  }
  return chatOpenAiPost(backend, request, messages, signal);
}

/**
 * Built-in OmniRoute free provider with failover + always-on Opal fallback.
 */
export class OmnirouteAdapter implements AiProviderAdapter {
  readonly id = 'omniroute' as const;

  async chat(
    config: ProviderConfig,
    request: ProviderChatRequest,
    options?: { signal?: AbortSignal; onProgress?: OmnirouteProgress },
  ): Promise<ProviderChatResult> {
    const backends = resolveFreeBackends(request.model || config.model);
    const messages = withOpalIdentity(request.messages);
    const errors: string[] = [];
    const onProgress = options?.onProgress;

    for (const backend of backends) {
      if (options?.signal?.aborted) throw new Error('Request cancelled');
      onProgress?.(
        backend.kind === 'local_opal'
          ? 'Answering as Opal Advisor…'
          : `Trying ${backend.label}…`,
      );

      // One quick retry for flaky free hosts (skip local).
      const attempts = backend.kind === 'local_opal' ? 1 : 2;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          const result = await chatOnce(
            backend,
            request,
            messages,
            options?.signal,
          );
          onProgress?.(
            backend.kind === 'local_opal'
              ? 'Opal Advisor ready'
              : `Connected via ${backend.label}`,
          );
          return result;
        } catch (err: any) {
          const msg = err?.message || String(err);
          errors.push(attempt > 1 ? `${msg} (retry)` : msg);
          if (attempt < attempts) {
            onProgress?.(`${backend.label} busy — retrying…`);
            await new Promise((r) => setTimeout(r, 400));
          }
        }
      }
    }

    throw new HttpException(
      {
        statusCode: HttpStatus.BAD_GATEWAY,
        message:
          'Free AI routes are unavailable right now. Try again shortly, or connect OpenRouter in Settings → AI.',
        errors: errors.slice(0, 6),
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
    const progressNotes: string[] = [];
    const result = await this.chat(config, request, {
      signal,
      onProgress: (message) => progressNotes.push(message),
    });
    // Soft-stream so the UI feels alive after a long free-route wait.
    const chunkSize = 18;
    for (let i = 0; i < result.content.length; i += chunkSize) {
      if (signal?.aborted) throw new Error('Request cancelled');
      yield result.content.slice(i, i + chunkSize);
    }
    return result;
  }

  /** Used by advisor stream to surface live routing status. */
  async chatWithProgress(
    config: ProviderConfig,
    request: ProviderChatRequest,
    onProgress: OmnirouteProgress,
    signal?: AbortSignal,
  ): Promise<ProviderChatResult> {
    return this.chat(config, request, { signal, onProgress });
  }

  async testConnection(
    config: ProviderConfig,
  ): Promise<{ ok: boolean; message: string; model?: string }> {
    const backends = resolveFreeBackends(config.model || 'auto').filter(
      (b) => b.kind !== 'local_opal',
    );
    const errors: string[] = [];

    for (const backend of backends.slice(0, 6)) {
      try {
        const result = await chatOnce(
          backend,
          {
            model: config.model || 'auto',
            messages: [
              {
                role: 'user',
                content: 'Reply with exactly: ok',
              },
            ],
            maxTokens: 12,
          },
          withOpalIdentity([
            { role: 'user', content: 'Reply with exactly: ok' },
          ]),
        );
        if (/ok/i.test(result.content) || result.content.trim().length > 0) {
          return {
            ok: true,
            message: `Connected · ${backend.label}. Free chat is ready.`,
            model: result.model,
          };
        }
      } catch (err: any) {
        errors.push(err?.message || String(err));
      }
    }

    // Local Opal always works — mark ok with warning so Use free still activates.
    return {
      ok: true,
      message:
        'Remote free routes are busy right now. Opal Advisor built-in replies are available; remote models will be tried again on each chat.' +
        (errors[0] ? ` Last error: ${errors[0]}` : ''),
      model: 'omniroute/opal-local',
    };
  }

  async listModels(): Promise<string[]> {
    return [...OMNIROUTE_FREE_MODELS];
  }
}

export const omnirouteAdapter = new OmnirouteAdapter();
