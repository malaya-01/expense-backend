export const AI_PROVIDERS = [
  'openrouter',
  'openai',
  'anthropic',
  'local',
  'vertex',
] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  attachments?: ProviderAttachment[];
  name?: string;
  tool_call_id?: string;
};

export type ProviderAttachment = {
  name: string;
  mimeType: string;
  dataBase64: string;
};

export type ProviderChatRequest = {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
};

/** Default completion budget for advisor replies (was 2048 and cut long answers short). */
export const DEFAULT_MAX_OUTPUT_TOKENS = Number(
  process.env.AI_MAX_OUTPUT_TOKENS || 8192,
);

export type ProviderChatResult = {
  content: string;
  model: string;
  provider: AiProviderId;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export type ProviderCredentials = {
  apiKey?: string;
  /** Raw service-account JSON string for Vertex */
  serviceAccountJson?: string;
  baseUrl?: string;
  projectId?: string;
  location?: string;
};

export type ProviderConfig = {
  provider: AiProviderId;
  model: string;
  baseUrl?: string | null;
  projectId?: string | null;
  location?: string | null;
  credentials: ProviderCredentials;
};

export interface AiProviderAdapter {
  readonly id: AiProviderId;
  chat(config: ProviderConfig, request: ProviderChatRequest): Promise<ProviderChatResult>;
  /** Optional token stream; adapters without native streaming may omit this. */
  streamChat?(
    config: ProviderConfig,
    request: ProviderChatRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<string, ProviderChatResult, void>;
  testConnection(config: ProviderConfig): Promise<{ ok: boolean; message: string; model?: string }>;
  listModels?(config: ProviderConfig): Promise<string[]>;
}

export const DEFAULT_MODELS: Record<AiProviderId, string[]> = {
  /** OpenRouter model slugs — browse more at https://openrouter.ai/models */
  openrouter: [
    'openai/gpt-4o-mini',
    'openai/gpt-4o',
    'anthropic/claude-sonnet-4',
    'anthropic/claude-3.5-haiku',
    'google/gemini-2.5-flash',
    'google/gemini-2.5-pro',
    'deepseek/deepseek-chat',
    'meta-llama/llama-3.3-70b-instruct',
    'qwen/qwen-2.5-72b-instruct',
    'mistralai/mistral-small-3.1-24b-instruct',
  ],
  openai: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini', 'gpt-4o', 'o4-mini'],
  anthropic: [
    'claude-3-5-haiku-latest',
    'claude-sonnet-4-20250514',
  ],
  local: ['llama3.2', 'llama3.1', 'mistral', 'qwen2.5', 'phi4'],
  vertex: [
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
  ],
};
