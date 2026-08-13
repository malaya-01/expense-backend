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
  FREE_ROUTE_BUDGET_MS,
  OMNIROUTE_FREE_MODELS,
  freeRouteSpeedHint,
  localOpalBackend,
  resolveRemoteFreeBackends,
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

const OPAL_VOICE_PREFIX = `You are Opal Advisor — the built-in intelligence of Opal (the Personal Financial Operating System). You are not ChatGPT, Claude, Gemini, or any outside chatbot. Speak only as Opal: warm, calm, first-person product voice. Never say you are a language model from another company. Prefer Opal screen names and Markdown links like [Accounts](/accounts). Keep answers concise.`;

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
          2048,
        ),
        stream: false,
      }),
    },
    backend.timeoutMs || FREE_ROUTE_BUDGET_MS,
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
  return chatOpenAiPost(backend, request, messages, signal);
}

/**
 * Race remote backends; first success wins. Fall back to instant local Opal.
 */
async function raceRemotes(
  backends: FreeBackend[],
  request: ProviderChatRequest,
  messages: ChatMessage[],
  onProgress?: OmnirouteProgress,
  signal?: AbortSignal,
): Promise<ProviderChatResult | null> {
  if (!backends.length) return null;

  onProgress?.(
    backends.length === 1
      ? `Asking ${backends[0].label}…`
      : `Racing ${backends.map((b) => b.label).join(' · ')}…`,
  );

  return await new Promise<ProviderChatResult | null>((resolve) => {
    let settled = false;
    let pending = backends.length;
    const errors: string[] = [];

    const finishNull = () => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    };

    for (const backend of backends) {
      void chatOnce(backend, request, messages, signal)
        .then((result) => {
          if (settled) return;
          settled = true;
          onProgress?.(`Connected via ${backend.label}`);
          resolve(result);
        })
        .catch((err: any) => {
          errors.push(err?.message || String(err));
          pending -= 1;
          if (pending <= 0) finishNull();
        });
    }

    // Hard budget — don't leave the user waiting on slow free hosts.
    setTimeout(finishNull, FREE_ROUTE_BUDGET_MS + 250);
  });
}

/**
 * Fast Opal Free provider: Groq/Gemini race, then built-in Opal voice.
 */
export class OmnirouteAdapter implements AiProviderAdapter {
  readonly id = 'omniroute' as const;

  async chat(
    config: ProviderConfig,
    request: ProviderChatRequest,
    options?: { signal?: AbortSignal; onProgress?: OmnirouteProgress },
  ): Promise<ProviderChatResult> {
    const messages = withOpalIdentity(request.messages);
    const remotes = resolveRemoteFreeBackends(request.model || config.model);
    const onProgress = options?.onProgress;

    if (!remotes.length) {
      onProgress?.('Answering as Opal Advisor…');
      return chatOnce(localOpalBackend(), request, messages, options?.signal);
    }

    const raced = await raceRemotes(
      remotes,
      request,
      messages,
      onProgress,
      options?.signal,
    );
    if (raced) return raced;

    onProgress?.('Free models busy — answering as Opal Advisor…');
    return chatOnce(localOpalBackend(), request, messages, options?.signal);
  }

  async *streamChat(
    config: ProviderConfig,
    request: ProviderChatRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<string, ProviderChatResult, void> {
    const result = await this.chat(config, request, { signal });
    const chunkSize = 24;
    for (let i = 0; i < result.content.length; i += chunkSize) {
      if (signal?.aborted) throw new Error('Request cancelled');
      yield result.content.slice(i, i + chunkSize);
    }
    return result;
  }

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
    const remotes = resolveRemoteFreeBackends(config.model || 'auto');
    if (!remotes.length) {
      return {
        ok: true,
        message:
          'No Groq/Gemini/OpenRouter platform key configured — Opal Advisor built-in replies are instant. Add GROQ_API_KEY on the server for fast free LLM replies.',
        model: 'omniroute/opal-local',
      };
    }

    try {
      const result = await raceRemotes(
        remotes,
        {
          model: config.model || 'auto',
          messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
          maxTokens: 8,
        },
        withOpalIdentity([{ role: 'user', content: 'Reply with exactly: ok' }]),
      );
      if (result) {
        return {
          ok: true,
          message: `Connected · ${freeRouteSpeedHint()}. Free chat is ready.`,
          model: result.model,
        };
      }
    } catch {
      /* fall through */
    }

    return {
      ok: true,
      message: `Remote free models did not respond in time. Built-in Opal Advisor still works instantly. Hint: ${freeRouteSpeedHint()}.`,
      model: 'omniroute/opal-local',
    };
  }

  async listModels(): Promise<string[]> {
    return [...OMNIROUTE_FREE_MODELS];
  }
}

export const omnirouteAdapter = new OmnirouteAdapter();
