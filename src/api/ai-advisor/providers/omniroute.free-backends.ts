/**
 * Free, no-auth OpenAI-compatible backends used by the built-in OmniRoute
 * provider. Priority order matches OmniRoute's free-forever guidance:
 * Pollinations first (no key), then optional self-hosted OmniRoute gateway.
 */

export type FreeBackend = {
  id: string;
  label: string;
  /** Full chat completions URL (…/chat/completions or …/openai). */
  chatUrl: string;
  /** Upstream model id sent to this backend. */
  upstreamModel: string;
  /** Optional Bearer token (OmniRoute dashboard key). */
  apiKey?: string;
  /** Skip Authorization header entirely (true no-auth). */
  noAuth?: boolean;
  requiresAuthSignup?: boolean;
};

export const OMNIROUTE_DAILY_SUCCESS_LIMIT = Number(
  process.env.OMNIROUTE_DAILY_LIMIT || 20,
);

/** Curated free models users can switch between (no signup). */
export const OMNIROUTE_FREE_MODELS = [
  'auto',
  'openai',
  'openai-fast',
  'deepseek',
  'mistral',
  'llama',
  'gemini',
] as const;

export type OmnirouteFreeModel = (typeof OMNIROUTE_FREE_MODELS)[number];

function pollinationsBackend(
  model: string,
  label?: string,
): FreeBackend {
  return {
    id: `pollinations:${model}`,
    label: label || `Pollinations · ${model}`,
    chatUrl: 'https://text.pollinations.ai/openai',
    upstreamModel: model,
    noAuth: true,
  };
}

/**
 * Build the ordered candidate list for a user-selected model.
 * `auto` tries several free backends; specific models prefer matching
 * Pollinations ids first, then fall back across other free options.
 */
export function resolveFreeBackends(selectedModel: string): FreeBackend[] {
  const model = (selectedModel || 'auto').trim() || 'auto';
  const gateway = (process.env.OMNIROUTE_BASE_URL || '').replace(/\/$/, '');
  const gatewayKey = (process.env.OMNIROUTE_API_KEY || '').trim();

  const pollinationsPriority: FreeBackend[] = [
    pollinationsBackend('openai', 'Pollinations · openai'),
    pollinationsBackend('openai-fast', 'Pollinations · openai-fast'),
    pollinationsBackend('deepseek', 'Pollinations · deepseek'),
    pollinationsBackend('mistral', 'Pollinations · mistral'),
    pollinationsBackend('llama', 'Pollinations · llama'),
    pollinationsBackend('gemini', 'Pollinations · gemini'),
  ];

  const candidates: FreeBackend[] = [];

  if (model === 'auto') {
    candidates.push(...pollinationsPriority);
  } else {
    const preferred = pollinationsPriority.find(
      (b) => b.upstreamModel === model || b.id.endsWith(`:${model}`),
    );
    if (preferred) candidates.push(preferred);
    for (const b of pollinationsPriority) {
      if (!candidates.some((c) => c.id === b.id)) candidates.push(b);
    }
  }

  // Optional self-hosted OmniRoute gateway (ops-configured). Tried after
  // no-auth free backends so signup-free options stay first.
  if (gateway) {
    const path = gateway.endsWith('/v1') ? gateway : `${gateway}/v1`;
    candidates.push({
      id: 'omniroute-gateway',
      label: 'OmniRoute gateway',
      chatUrl: `${path}/chat/completions`,
      upstreamModel: model === 'auto' ? 'auto' : model,
      apiKey: gatewayKey || 'omniroute',
      requiresAuthSignup: false,
    });
  }

  return candidates;
}

export function isOmnirouteProvider(provider: string | null | undefined): boolean {
  return provider === 'omniroute';
}
