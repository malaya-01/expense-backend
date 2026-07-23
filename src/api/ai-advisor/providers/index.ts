import {
  AiProviderAdapter,
  AiProviderId,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MODELS,
  ChatMessage,
  ProviderConfig,
} from './types';
import { anthropicAdapter } from './anthropic.adapter';
import {
  localAdapter,
  openAiAdapter,
} from './openai-compatible.adapter';
import { vertexAdapter } from './vertex.adapter';

const adapters: Record<AiProviderId, AiProviderAdapter> = {
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
  request: { model: string; messages: ChatMessage[]; temperature?: number; maxTokens?: number },
) {
  return {
    ...request,
    maxTokens: request.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  };
}

export async function runProviderChat(
  config: ProviderConfig,
  messages: ChatMessage[],
  maxTokens?: number,
) {
  const adapter = getProviderAdapter(config.provider);
  return adapter.chat(
    config,
    withDefaultBudget({
      model: config.model,
      messages,
      maxTokens,
    }),
  );
}

/** Yields text deltas; returns the final ProviderChatResult. */
export async function* runProviderChatStream(
  config: ProviderConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
  maxTokens?: number,
) {
  const adapter = getProviderAdapter(config.provider);
  const request = withDefaultBudget({
    model: config.model,
    messages,
    maxTokens,
  });
  if (adapter.streamChat) {
    return yield* adapter.streamChat(config, request, signal);
  }
  const result = await adapter.chat(config, request);
  // Soft-stream non-native providers in small chunks for UI responsiveness.
  const chunkSize = 6;
  for (let i = 0; i < result.content.length; i += chunkSize) {
    if (signal?.aborted) {
      throw new Error('Request cancelled');
    }
    yield result.content.slice(i, i + chunkSize);
  }
  return result;
}
