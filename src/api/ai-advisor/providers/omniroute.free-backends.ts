/**
 * Fast free backends for built-in Opal Free (users never paste keys).
 * Pollinations/OmniRoute cascades were too slow — prefer Groq, then Gemini,
 * then optional OpenRouter free, then instant local Opal voice.
 */

export type FreeBackend = {
  id: string;
  label: string;
  kind: 'openai_post' | 'gemini_native' | 'local_opal';
  chatUrl?: string;
  upstreamModel: string;
  apiKey?: string;
  noAuth?: boolean;
  timeoutMs?: number;
};

export const OMNIROUTE_DAILY_SUCCESS_LIMIT = Number(
  process.env.OMNIROUTE_DAILY_LIMIT || 20,
);

/** Hard cap for remote free routing before local Opal answers. */
export const FREE_ROUTE_BUDGET_MS = Number(
  process.env.OMNIROUTE_ROUTE_BUDGET_MS || 8_000,
);

export const OMNIROUTE_FREE_MODELS = [
  'auto',
  'fast',
  'balanced',
  'gemini',
] as const;

export type OmnirouteFreeModel = (typeof OMNIROUTE_FREE_MODELS)[number];

function groqKey(): string {
  return (process.env.GROQ_API_KEY || '').trim();
}

function geminiKey(): string {
  return (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_AI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    ''
  ).trim();
}

function openRouterKey(): string {
  return (
    process.env.OMNIROUTE_PLATFORM_KEY ||
    process.env.OPENROUTER_API_KEY ||
    ''
  ).trim();
}

function groqModelFor(alias: string): string {
  if (alias === 'balanced') return 'openai/gpt-oss-120b';
  // Llama 3.x chat models were retired from Groq in 2026.
  return 'openai/gpt-oss-20b';
}

function openRouterModelFor(alias: string): string {
  if (alias === 'balanced') return 'meta-llama/llama-3.3-70b-instruct:free';
  if (alias === 'gemini') return 'google/gemma-3-27b-it:free';
  return 'nvidia/nemotron-3-nano-30b-a3b:free';
}

/**
 * Groq on-demand free tier rejects max_tokens above the OTPM cap (1000).
 * Receipt JSON does not need 1024 tokens — stay well under the gate.
 */
export const GROQ_FREE_MAX_OUTPUT_TOKENS = Math.min(
  Number(process.env.GROQ_MAX_OUTPUT_TOKENS || 768),
  768,
);

/** Groq Llama 4 Scout was retired July 2026. Current Groq vision models: */
export const GROQ_VISION_MODELS = [
  'qwen/qwen3.6-27b',
  'qwen/qwen3.8-27b',
] as const;
export const GROQ_VISION_MODEL = GROQ_VISION_MODELS[0];
/** Gemini 2.0 Flash was retired; 3.6 is the current vision Flash. */
export const GEMINI_VISION_MODELS = [
  'gemini-3.6-flash',
  'gemini-2.5-flash',
] as const;
export const GEMINI_VISION_MODEL = GEMINI_VISION_MODELS[0];
export const VISION_ROUTE_TIMEOUT_MS = Number(
  process.env.OMNIROUTE_VISION_TIMEOUT_MS || 45_000,
);

/**
 * Vision backends for receipt OCR. Text-only Groq chat models are excluded
 * so they cannot "succeed" without seeing the image.
 * Order: Opal Free Groq vision, then Gemini Flash (native image API).
 */
export function resolveVisionFreeBackends(options?: {
  skipGroq?: boolean;
}): FreeBackend[] {
  const candidates: FreeBackend[] = [];
  const gKey = groqKey();
  if (gKey && !options?.skipGroq) {
    for (const model of GROQ_VISION_MODELS) {
      candidates.push({
        id: `groq:${model}`,
        label: `Groq vision (${model.split('/')[1] || model})`,
        kind: 'openai_post',
        chatUrl: 'https://api.groq.com/openai/v1/chat/completions',
        upstreamModel: model,
        apiKey: gKey,
        timeoutMs: VISION_ROUTE_TIMEOUT_MS,
      });
    }
  }
  const gemKey = geminiKey();
  if (gemKey) {
    for (const model of GEMINI_VISION_MODELS) {
      candidates.push({
        id: `gemini:${model}`,
        label: `Gemini (${model})`,
        kind: 'gemini_native',
        chatUrl: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        upstreamModel: model,
        apiKey: gemKey,
        timeoutMs: VISION_ROUTE_TIMEOUT_MS,
      });
    }
  }
  return candidates;
}

export function resolveRemoteFreeBackends(selectedModel: string): FreeBackend[] {
  const model = (selectedModel || 'auto').trim() || 'auto';
  const candidates: FreeBackend[] = [];

  const gKey = groqKey();
  if (gKey && model !== 'gemini') {
    candidates.push({
      id: `groq:${groqModelFor(model)}`,
      label: 'Groq (fast)',
      kind: 'openai_post',
      chatUrl: 'https://api.groq.com/openai/v1/chat/completions',
      upstreamModel: groqModelFor(model),
      apiKey: gKey,
      timeoutMs: FREE_ROUTE_BUDGET_MS,
    });
  }

  const gemKey = geminiKey();
  if (gemKey && (model === 'auto' || model === 'gemini' || model === 'fast')) {
    candidates.push({
      id: 'gemini:flash',
      label: 'Gemini Flash',
      kind: 'openai_post',
      chatUrl:
        'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      upstreamModel: GEMINI_VISION_MODEL,
      apiKey: gemKey,
      timeoutMs: FREE_ROUTE_BUDGET_MS,
    });
  }

  const orKey = openRouterKey();
  if (orKey) {
    const orModel = openRouterModelFor(model);
    candidates.push({
      id: `openrouter:${orModel}`,
      label: 'OpenRouter free',
      kind: 'openai_post',
      chatUrl: 'https://openrouter.ai/api/v1/chat/completions',
      upstreamModel: orModel,
      apiKey: orKey,
      timeoutMs: FREE_ROUTE_BUDGET_MS,
    });
  }

  return candidates;
}

export function localOpalBackend(): FreeBackend {
  return {
    id: 'local-opal',
    label: 'Opal Advisor (built-in)',
    kind: 'local_opal',
    upstreamModel: 'opal-local',
    noAuth: true,
    timeoutMs: 50,
  };
}

/** @deprecated Prefer resolveRemoteFreeBackends + race; kept for callers. */
export function resolveFreeBackends(selectedModel: string): FreeBackend[] {
  return [...resolveRemoteFreeBackends(selectedModel), localOpalBackend()];
}

export function isOmnirouteProvider(
  provider: string | null | undefined,
): boolean {
  return provider === 'omniroute';
}

export function hasPlatformFreeKey(): boolean {
  return Boolean(groqKey() || geminiKey() || openRouterKey());
}

export function freeRouteSpeedHint(): string {
  if (groqKey()) return 'Groq fast free tier';
  if (geminiKey()) return 'Gemini Flash';
  if (openRouterKey()) return 'OpenRouter free';
  return 'Built-in Opal Advisor (instant)';
}
