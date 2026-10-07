import {
  AiProviderAdapter,
  AiProviderId,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MODELS,
  ChatMessage,
  ProviderChatResult,
  ProviderConfig,
} from './types';
import {
  ContinuationJoiner,
  TRUNCATION_NOTICE,
  buildContinuationMessages,
  stitchPiece,
} from './continuation';
import { anthropicAdapter } from './anthropic.adapter';
import {
  localAdapter,
  openAiAdapter,
  openRouterAdapter,
} from './openai-compatible.adapter';
import { omnirouteAdapter } from './omniroute.adapter';
import { vertexAdapter } from './vertex.adapter';

const adapters: Record<AiProviderId, AiProviderAdapter> = {
  omniroute: omnirouteAdapter,
  openrouter: openRouterAdapter,
  openai: openAiAdapter,
  anthropic: anthropicAdapter,
  local: localAdapter,
  vertex: vertexAdapter,
};

export function getProviderAdapter(provider: AiProviderId): AiProviderAdapter {
  const adapter = adapters[provider];
  if (!adapter) {
    throw new Error(`Unsupported provider: ${provider}`);
  }
  return adapter;
}

export function getDefaultModels(provider: AiProviderId): string[] {
  return DEFAULT_MODELS[provider] || [];
}

function withDefaultBudget(
  request: {
    model: string;
    messages: ChatMessage[];
    temperature?: number;
    maxTokens?: number;
    maxContinuations?: number;
  },
) {
  return {
    ...request,
    maxTokens: request.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  };
}

export type ContinuationOptions = {
  /**
   * Extra requests after a max_tokens / length stop (default 0 so JSON
   * callers never get prose stitched in). Prose callers pass MAX_CONTINUATIONS.
   */
  maxContinuations?: number;
};

/**
 * One chat completion; when `maxContinuations` > 0 and the provider stopped on
 * its output limit, ask it to continue (as a user turn) and stitch the parts.
 */
export async function runProviderChat(
  config: ProviderConfig,
  messages: ChatMessage[],
  maxTokens?: number,
  options?: ContinuationOptions,
): Promise<ProviderChatResult> {
  const adapter = getProviderAdapter(config.provider);
  const maxContinuations = Math.max(0, options?.maxContinuations ?? 0);
  const request = withDefaultBudget({
    model: config.model,
    messages,
    maxTokens,
    // Opal Free races several backends and must continue on the winner.
    ...(config.provider === 'omniroute' ? { maxContinuations } : {}),
  });
  const first = await adapter.chat(config, request);
  if (config.provider === 'omniroute' || !maxContinuations) return first;

  let content = first.content;
  let truncated = Boolean(first.truncated);
  let attempts = 0;
  while (truncated && attempts < maxContinuations) {
    attempts += 1;
    let next: ProviderChatResult;
    try {
      next = await adapter.chat(config, {
        ...request,
        messages: buildContinuationMessages(messages, content),
      });
    } catch {
      break;
    }
    const piece = stitchPiece(content, next.content);
    truncated = Boolean(next.truncated);
    if (!piece.trim()) break;
    content += piece;
  }
  if (truncated) content += TRUNCATION_NOTICE;
  return { ...first, content, truncated, continuations: attempts };
}

/**
 * Yields text deltas; returns the final ProviderChatResult. Continuation
 * segments are streamed too (overlap-trimmed by ContinuationJoiner).
 */
export async function* runProviderChatStream(
  config: ProviderConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
  maxTokens?: number,
  options?: ContinuationOptions,
): AsyncGenerator<string, ProviderChatResult, void> {
  const adapter = getProviderAdapter(config.provider);
  const maxContinuations = Math.max(0, options?.maxContinuations ?? 0);
  const request = withDefaultBudget({
    model: config.model,
    messages,
    maxTokens,
    ...(config.provider === 'omniroute' ? { maxContinuations } : {}),
  });

  const streamOnce = async function* (
    req: typeof request,
  ): AsyncGenerator<string, ProviderChatResult, void> {
    if (adapter.streamChat) {
      return yield* adapter.streamChat(config, req, signal);
    }
    const result = await adapter.chat(config, req);
    // Soft-stream non-native providers in small chunks for UI responsiveness.
    const chunkSize = 6;
    for (let i = 0; i < result.content.length; i += chunkSize) {
      if (signal?.aborted) {
        throw new Error('Request cancelled');
      }
      yield result.content.slice(i, i + chunkSize);
    }
    return result;
  };

  let content = '';
  const first = yield* (async function* () {
    const inner = streamOnce(request);
    while (true) {
      const step = await inner.next();
      if (step.done) return step.value;
      content += step.value;
      yield step.value;
    }
  })();
  // Adapters return the authoritative text (it may include a closing notice).
  content = first.content || content;
  if (config.provider === 'omniroute' || !maxContinuations) return first;

  let truncated = Boolean(first.truncated);
  let attempts = 0;
  while (truncated && attempts < maxContinuations && !signal?.aborted) {
    attempts += 1;
    const joiner = new ContinuationJoiner(content);
    let appended = '';
    let next: ProviderChatResult | null = null;
    try {
      const inner = streamOnce({
        ...request,
        messages: buildContinuationMessages(messages, content),
      });
      while (true) {
        const step = await inner.next();
        if (step.done) {
          next = step.value;
          break;
        }
        const out = joiner.push(step.value);
        if (out) {
          appended += out;
          yield out;
        }
      }
      const tail = joiner.flush();
      if (tail) {
        appended += tail;
        yield tail;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      // Keep what streamed so far; a failed continuation must not lose the reply.
      const tail = joiner.flush();
      if (tail) {
        appended += tail;
        yield tail;
      }
      content += appended;
      break;
    }
    content += appended;
    truncated = Boolean(next?.truncated);
    if (!appended.trim()) break;
  }
  if (truncated) {
    content += TRUNCATION_NOTICE;
    yield TRUNCATION_NOTICE;
  }
  return { ...first, content, truncated, continuations: attempts };
}
