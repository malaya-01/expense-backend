import {
  AiProviderAdapter,
  AiProviderId,
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

export async function runProviderChat(
  config: ProviderConfig,
  messages: ChatMessage[],
) {
  const adapter = getProviderAdapter(config.provider);
  return adapter.chat(config, {
    model: config.model,
    messages,
  });
}

/** Yields text deltas; returns the final ProviderChatResult. */
export async function* runProviderChatStream(
  config: ProviderConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
) {
  const adapter = getProviderAdapter(config.provider);
  const request = { model: config.model, messages };
  if (adapter.streamChat) {
    return yield* adapter.streamChat(config, request, signal);
  }
  const result = await adapter.chat(config, request);
  // Soft-stream non-native providers in small chunks for UI responsiveness.
  const chunkSize = 48;
  for (let i = 0; i < result.content.length; i += chunkSize) {
    if (signal?.aborted) {
      throw new Error('Request cancelled');
    }
    yield result.content.slice(i, i + chunkSize);
  }
  return result;
}
