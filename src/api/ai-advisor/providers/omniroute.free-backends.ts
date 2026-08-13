/**
 * Fast free backends for built-in Opal Free (users never paste keys).
 * Pollinations/OmniRoute cascades were too slow — prefer Groq, then Gemini,
 * then optional OpenRouter free, then instant local Opal voice.
 */

export type FreeBackend = {
  id: string;
  label: string;
  kind: 'openai_post' | 'local_opal';
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
  if (alias === 'balanced') return 'llama-3.3-70b-versatile';
  // auto / fast — tiny + fastest free model
  return 'llama-3.1-8b-instant';
}

function openRouterModelFor(alias: string): string {
  if (alias === 'balanced') return 'meta-llama/llama-3.3-70b-instruct:free';
  if (alias === 'gemini') return 'google/gemma-3-27b-it:free';
  return 'nvidia/nemotron-3-nano-30b-a3b:free';
}

/**
 * Remote candidates only (no local). Kept short on purpose for speed.
 */
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
      upstreamModel: 'gemini-2.0-flash',
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
