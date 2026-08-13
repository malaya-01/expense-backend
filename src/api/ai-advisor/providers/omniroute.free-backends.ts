/**
 * Free backends for built-in OmniRoute (end users never paste keys).
 * Priority: platform OpenRouter free key → Pollinations (retry) → local Opal voice.
 */

export type FreeBackend = {
  id: string;
  label: string;
  kind: 'openai_post' | 'pollinations_get' | 'local_opal';
  chatUrl?: string;
  upstreamModel: string;
  apiKey?: string;
  noAuth?: boolean;
  timeoutMs?: number;
};

export const OMNIROUTE_DAILY_SUCCESS_LIMIT = Number(
  process.env.OMNIROUTE_DAILY_LIMIT || 20,
);

/** Curated free models users can switch between (no signup). */
export const OMNIROUTE_FREE_MODELS = [
  'auto',
  'openai',
  'mistral',
  'llama',
  'deepseek',
  'gemini',
] as const;

export type OmnirouteFreeModel = (typeof OMNIROUTE_FREE_MODELS)[number];

const OPENROUTER_FREE_BY_ALIAS: Record<string, string> = {
  auto: 'openrouter/free',
  openai: 'nvidia/nemotron-3-nano-30b-a3b:free',
  mistral: 'mistralai/mistral-small-3.1-24b-instruct:free',
  llama: 'meta-llama/llama-3.3-70b-instruct:free',
  deepseek: 'deepseek/deepseek-r1-distill-llama-70b:free',
  gemini: 'google/gemma-3-27b-it:free',
};

function platformOpenRouterKey(): string {
  return (
    process.env.OMNIROUTE_PLATFORM_KEY ||
    process.env.OPENROUTER_API_KEY ||
    ''
  ).trim();
}

function pollinationsPost(model: string): FreeBackend {
  return {
    id: `pollinations-post:${model}`,
    label: `Pollinations · ${model}`,
    kind: 'openai_post',
    chatUrl: 'https://text.pollinations.ai/openai',
    upstreamModel: model,
    noAuth: true,
    timeoutMs: 55_000,
  };
}

function pollinationsGet(model: string): FreeBackend {
  return {
    id: `pollinations-get:${model}`,
    label: `Pollinations GET · ${model}`,
    kind: 'pollinations_get',
    chatUrl: 'https://text.pollinations.ai',
    upstreamModel: model,
    noAuth: true,
    timeoutMs: 45_000,
  };
}

/**
 * Ordered candidates for a user-selected free model.
 * Local Opal voice is always last so chat never hard-fails.
 */
export function resolveFreeBackends(selectedModel: string): FreeBackend[] {
  const model = (selectedModel || 'auto').trim() || 'auto';
  const candidates: FreeBackend[] = [];
  const platformKey = platformOpenRouterKey();
  const gateway = (process.env.OMNIROUTE_BASE_URL || '').replace(/\/$/, '');
  const gatewayKey = (process.env.OMNIROUTE_API_KEY || '').trim();

  if (platformKey) {
    const orModel =
      OPENROUTER_FREE_BY_ALIAS[model] || OPENROUTER_FREE_BY_ALIAS.auto;
    candidates.push({
      id: `openrouter-free:${orModel}`,
      label: `OpenRouter free · ${orModel}`,
      kind: 'openai_post',
      chatUrl: 'https://openrouter.ai/api/v1/chat/completions',
      upstreamModel: orModel,
      apiKey: platformKey,
      timeoutMs: 60_000,
    });
    if (model === 'auto') {
      for (const alias of ['mistral', 'llama', 'openai'] as const) {
        const id = OPENROUTER_FREE_BY_ALIAS[alias];
        if (id === orModel) continue;
        candidates.push({
          id: `openrouter-free:${id}`,
          label: `OpenRouter free · ${id}`,
          kind: 'openai_post',
          chatUrl: 'https://openrouter.ai/api/v1/chat/completions',
          upstreamModel: id,
          apiKey: platformKey,
          timeoutMs: 60_000,
        });
      }
    }
  }

  const pollModels =
    model === 'auto'
      ? ['openai', 'mistral', 'llama', 'deepseek', 'gemini']
      : [model, 'openai', 'mistral'];

  const seen = new Set<string>();
  for (const m of pollModels) {
    if (seen.has(m)) continue;
    seen.add(m);
    candidates.push(pollinationsPost(m));
    candidates.push(pollinationsGet(m));
  }

  if (gateway) {
    const path = gateway.endsWith('/v1') ? gateway : `${gateway}/v1`;
    candidates.push({
      id: 'omniroute-gateway',
      label: 'OmniRoute gateway',
      kind: 'openai_post',
      chatUrl: `${path}/chat/completions`,
      upstreamModel: model === 'auto' ? 'auto' : model,
      apiKey: gatewayKey || 'omniroute',
      timeoutMs: 60_000,
    });
  }

  candidates.push({
    id: 'local-opal',
    label: 'Opal Advisor (built-in)',
    kind: 'local_opal',
    upstreamModel: 'opal-local',
    noAuth: true,
    timeoutMs: 1_000,
  });

  return candidates;
}

export function isOmnirouteProvider(
  provider: string | null | undefined,
): boolean {
  return provider === 'omniroute';
}

export function hasPlatformFreeKey(): boolean {
  return Boolean(platformOpenRouterKey());
}
