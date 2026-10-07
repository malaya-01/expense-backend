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
  GROQ_FREE_MAX_OUTPUT_TOKENS,
  OMNIROUTE_FREE_MODELS,
  freeRouteSpeedHint,
  localOpalBackend,
  resolveRemoteFreeBackends,
  resolveVisionFreeBackends,
} from './omniroute.free-backends';
import { buildLocalOpalReply } from './opal-local-reply';
import {
  TRUNCATION_NOTICE,
  buildContinuationMessages,
  isTruncationReason,
  stitchPiece,
} from './continuation';

export type OmnirouteProgress = (message: string) => void;
/** Receives reply text as soon as each segment (first reply, continuations) lands. */
export type OmnirouteSegment = (text: string) => void;

/**
 * Non-Groq free backends (Gemini Flash via OpenAI-compat, OpenRouter free).
 * Kept modest so one segment fits the free-route time budget; longer answers
 * are completed by continuation requests instead.
 */
const FREE_MAX_OUTPUT_TOKENS = Math.max(
  512,
  Number(process.env.OMNIROUTE_MAX_OUTPUT_TOKENS || 2048) || 2048,
);

/** Continuations get their own, longer budget (the user already sees text). */
const CONTINUATION_TIMEOUT_MS = Math.max(
  FREE_ROUTE_BUDGET_MS,
  Number(process.env.OMNIROUTE_CONTINUATION_TIMEOUT_MS || 20_000) || 20_000,
);

/**
 * Hidden reasoning shares the completion budget on gpt-oss (Groq) and Gemini
 * 2.5+/3 thinking models; with Groq's 768-token cap "medium" reasoning left
 * only a few hundred visible tokens. Ask for low effort where documented.
 */
function reasoningEffortFor(backend: FreeBackend): string | undefined {
  if (isGroqBackend(backend) && /gpt-oss/i.test(backend.upstreamModel)) {
    return 'low';
  }
  if (backend.chatUrl?.includes('generativelanguage.googleapis.com')) {
    return 'low';
  }
  return undefined;
}

function stripThink(text: string): string {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .trim();
}

function isGroqBackend(backend: FreeBackend): boolean {
  return Boolean(backend.chatUrl?.includes('api.groq.com'));
}

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
  const groq = isGroqBackend(backend);
  const tokenBudget = Math.min(
    request.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    groq ? GROQ_FREE_MAX_OUTPUT_TOKENS : FREE_MAX_OUTPUT_TOKENS,
  );
  const wantJson = Boolean(request.json) && !backend.upstreamModel.startsWith('qwen/');
  const reasoningEffort = request.json ? undefined : reasoningEffortFor(backend);
  const res = await fetchWithTimeout(
    backend.chatUrl,
    {
      method: 'POST',
      headers: headersFor(backend),
      body: JSON.stringify({
        model: backend.upstreamModel,
        messages: buildOpenAiMessages(messages),
        temperature: request.temperature ?? 0.35,
        max_tokens: tokenBudget,
        ...(groq ? { max_completion_tokens: tokenBudget } : {}),
        stream: false,
        ...(wantJson ? { response_format: { type: 'json_object' } } : {}),
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      }),
    },
    backend.timeoutMs || FREE_ROUTE_BUDGET_MS,
    signal,
  );

  if (!res.ok) {
    throw new Error(`${backend.label}: ${await readErrorText(res)}`);
  }

  const data = await res.json();
  const content = stripThink(String(data?.choices?.[0]?.message?.content || ''));
  const finishReason = data?.choices?.[0]?.finish_reason;
  if (!content) {
    throw new Error(
      `${backend.label}: ${isTruncationReason(finishReason) ? 'output limit reached before any visible text' : 'empty response'}`,
    );
  }

  return {
    content,
    model: `${backend.id}/${data?.model || backend.upstreamModel}`,
    provider: 'omniroute',
    finish_reason: finishReason ? String(finishReason) : undefined,
    truncated: isTruncationReason(finishReason),
    usage: {
      input_tokens: data?.usage?.prompt_tokens,
      output_tokens: data?.usage?.completion_tokens,
    },
  };
}

async function chatGeminiNative(
  backend: FreeBackend,
  request: ProviderChatRequest,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<ProviderChatResult> {
  if (!backend.chatUrl || !backend.apiKey) {
    throw new Error(`${backend.label}: missing URL or key`);
  }
  const parts: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.content?.trim()) {
      const prefix = message.role === 'system' ? 'Instructions:\n' : '';
      parts.push({ text: `${prefix}${message.content}` });
    }
    for (const file of message.attachments || []) {
      const mime =
        file.mimeType === 'image/jpg' ? 'image/jpeg' : file.mimeType;
      if (mime.startsWith('image/') || mime === 'application/pdf') {
        parts.push({
          inline_data: {
            mime_type: mime,
            data: file.dataBase64,
          },
        });
      }
    }
  }
  const url = `${backend.chatUrl}?key=${encodeURIComponent(backend.apiKey)}`;
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature: request.temperature ?? 0.1,
          // Thinking tokens share this budget on Gemini 2.5+/3 Flash; 2048
          // clipped long receipts (line items) mid-JSON.
          maxOutputTokens: Math.min(request.maxTokens ?? 1024, 4096),
          responseMimeType: 'application/json',
        },
      }),
    },
    backend.timeoutMs || FREE_ROUTE_BUDGET_MS,
    signal,
  );
  if (!res.ok) {
    throw new Error(`${backend.label}: ${await readErrorText(res)}`);
  }
  const data = await res.json();
  const content = stripThink(
    (data?.candidates?.[0]?.content?.parts || [])
      .map((part: { text?: string }) => part?.text || '')
      .join('\n')
      .trim(),
  );
  const finishReason = String(data?.candidates?.[0]?.finishReason || '');
  if (!content) {
    throw new Error(`${backend.label}: empty response`);
  }
  return {
    content,
    model: `${backend.id}/${backend.upstreamModel}`,
    provider: 'omniroute',
    finish_reason: finishReason || undefined,
    truncated: isTruncationReason(finishReason),
    usage: {
      input_tokens: data?.usageMetadata?.promptTokenCount,
      output_tokens: data?.usageMetadata?.candidatesTokenCount,
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
  if (backend.kind === 'gemini_native') {
    return chatGeminiNative(backend, request, messages, signal);
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
): Promise<{ result: ProviderChatResult; backend: FreeBackend } | null> {
  if (!backends.length) return null;

  onProgress?.(
    backends.length === 1
      ? `Asking ${backends[0].label}…`
      : `Racing ${backends.map((b) => b.label).join(' · ')}…`,
  );

  return await new Promise<{
    result: ProviderChatResult;
    backend: FreeBackend;
  } | null>((resolve) => {
    let settled = false;
    let pending = backends.length;
    const errors: string[] = [];

    const finishNull = (reason?: string) => {
      if (settled) return;
      settled = true;
      if (errors.length || reason) {
        const detail = [...errors, reason].filter(Boolean).slice(0, 3).join(' | ');
        console.warn(`[Opal Free] remote race failed: ${detail}`);
        onProgress?.(`Free route failed — ${detail.slice(0, 160)}`);
      }
      resolve(null);
    };

    for (const backend of backends) {
      void chatOnce(backend, request, messages, signal)
        .then((result) => {
          if (settled) return;
          settled = true;
          onProgress?.(`Connected via ${backend.label}`);
          resolve({ result, backend });
        })
        .catch((err: any) => {
          errors.push(err?.message || String(err));
          pending -= 1;
          if (pending <= 0) finishNull();
        });
    }

    // Hard budget — don't leave the user waiting on slow free hosts.
    setTimeout(
      () => finishNull('timed out'),
      FREE_ROUTE_BUDGET_MS + 250,
    );
  });
}

function isGroqQuotaError(detail: string): boolean {
  const text = detail.toLowerCase();
  return (
    text.includes('otpm') ||
    text.includes('tokens per minute') ||
    text.includes('request too large') ||
    text.includes('rate limit') ||
    text.includes('insufficient_quota') ||
    text.includes('reduce max_tokens')
  );
}

/**
 * Sequential vision OCR: Groq vision, then Gemini. Never uses local Opal
 * (it cannot see images and would invent fields).
 */
export async function trySequentialVisionChat(
  messages: ChatMessage[],
  options?: { skipGroq?: boolean; maxTokens?: number },
): Promise<{ result: ProviderChatResult | null; errors: string[] }> {
  const backends = resolveVisionFreeBackends({ skipGroq: options?.skipGroq });
  const base: ProviderChatRequest = {
    model: 'auto',
    messages,
    temperature: 0.1,
    maxTokens: GROQ_FREE_MAX_OUTPUT_TOKENS,
  };
  const errors: string[] = [];
  if (!backends.length) {
    return {
      result: null,
      errors: ['No Groq or Gemini vision key is configured on the server.'],
    };
  }
  let skipRemainingGroq = false;
  for (const backend of backends) {
    if (skipRemainingGroq && isGroqBackend(backend)) {
      continue;
    }
    const allowJson =
      backend.kind === 'gemini_native' ||
      (!isGroqBackend(backend) && !backend.upstreamModel.startsWith('qwen/'));
    try {
      const run = async (json: boolean) => {
        const maxTokens = isGroqBackend(backend)
          ? GROQ_FREE_MAX_OUTPUT_TOKENS
          : Math.min(options?.maxTokens ?? 3072, 4096);
        const result = await chatOnce(
          backend,
          { ...base, maxTokens, json },
          messages,
        );
        const start = result.content.indexOf('{');
        const end = result.content.lastIndexOf('}');
        if (start < 0) {
          throw new Error(`${backend.label}: no JSON object in reply`);
        }
        // A reply cut by the token cap is kept from '{' to the end: the
        // receipt parser repairs it (totals come first in the schema).
        if (result.truncated || end <= start) {
          return { ...result, content: result.content.slice(start) };
        }
        return { ...result, content: result.content.slice(start, end + 1) };
      };
      if (allowJson) {
        try {
          return { result: await run(true), errors };
        } catch {
          /* retry without JSON mode */
        }
      }
      return { result: await run(false), errors };
    } catch (err: any) {
      const detail = err?.message || String(err);
      errors.push(detail);
      console.warn(`[Opal vision] ${backend.label} failed: ${detail}`);
      if (isGroqBackend(backend) && isGroqQuotaError(detail)) {
        skipRemainingGroq = true;
      }
    }
  }
  if (errors.length) {
    console.warn(`[Opal vision] all backends failed: ${errors.join(' | ')}`);
  }
  return { result: null, errors };
}

/**
 * Fast Opal Free provider: Groq/Gemini race, then built-in Opal voice.
 */
export class OmnirouteAdapter implements AiProviderAdapter {
  readonly id = 'omniroute' as const;

  async chat(
    config: ProviderConfig,
    request: ProviderChatRequest,
    options?: {
      signal?: AbortSignal;
      onProgress?: OmnirouteProgress;
      onSegment?: OmnirouteSegment;
    },
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
    if (raced) {
      return this.continueOnBackend(
        raced.backend,
        raced.result,
        request,
        messages,
        options,
      );
    }

    onProgress?.('Free models busy — answering as Opal Advisor…');
    return chatOnce(localOpalBackend(), request, messages, options?.signal);
  }

  /**
   * Free backends cap output hard (Groq 768 tokens). When the winner stopped
   * on its limit, ask the SAME backend to continue (user turn, not prefill)
   * and stitch; segments are surfaced as they land so the UI can stream them.
   */
  private async continueOnBackend(
    backend: FreeBackend,
    first: ProviderChatResult,
    request: ProviderChatRequest,
    messages: ChatMessage[],
    options?: {
      signal?: AbortSignal;
      onProgress?: OmnirouteProgress;
      onSegment?: OmnirouteSegment;
    },
  ): Promise<ProviderChatResult> {
    const maxContinuations = Math.max(0, request.maxContinuations ?? 0);
    options?.onSegment?.(first.content);
    if (!first.truncated || !maxContinuations) return first;

    let content = first.content;
    let truncated = true;
    let attempts = 0;
    const slowBackend = { ...backend, timeoutMs: CONTINUATION_TIMEOUT_MS };
    while (truncated && attempts < maxContinuations) {
      if (options?.signal?.aborted) break;
      attempts += 1;
      options?.onProgress?.('Continuing the reply…');
      let next: ProviderChatResult;
      try {
        next = await chatOnce(
          slowBackend,
          request,
          buildContinuationMessages(messages, content),
          options?.signal,
        );
      } catch (err: any) {
        console.warn(
          `[Opal Free] continuation ${attempts} failed: ${err?.message || err}`,
        );
        break;
      }
      const piece = stitchPiece(content, next.content);
      truncated = Boolean(next.truncated);
      if (!piece.trim()) break;
      content += piece;
      options?.onSegment?.(piece);
    }
    if (truncated) {
      content += TRUNCATION_NOTICE;
      options?.onSegment?.(TRUNCATION_NOTICE);
    }
    return { ...first, content, truncated, continuations: attempts };
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
    onSegment?: OmnirouteSegment,
  ): Promise<ProviderChatResult> {
    return this.chat(config, request, { signal, onProgress, onSegment });
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
      const probeMessages = withOpalIdentity([
        { role: 'user', content: 'Reply with exactly: ok' },
      ]);
      const errors: string[] = [];
      for (const backend of remotes) {
        try {
          const result = await chatOnce(
            backend,
            {
              model: config.model || 'auto',
              messages: probeMessages,
              maxTokens: 8,
            },
            probeMessages,
          );
          return {
            ok: true,
            message: `Connected via ${backend.label} · ${freeRouteSpeedHint()}. Free chat is ready.`,
            model: result.model,
          };
        } catch (err: any) {
          errors.push(err?.message || String(err));
        }
      }
      return {
        ok: false,
        message: `Keys found (${remotes.map((r) => r.label).join(', ')}) but chat failed: ${errors.slice(0, 2).join(' | ')}. Check key validity on Render and redeploy.`,
        model: 'omniroute/opal-local',
      };
    } catch (err: any) {
      return {
        ok: false,
        message: err?.message || 'Free route probe failed',
        model: 'omniroute/opal-local',
      };
    }
  }

  async listModels(): Promise<string[]> {
    return [...OMNIROUTE_FREE_MODELS];
  }
}

export const omnirouteAdapter = new OmnirouteAdapter();
