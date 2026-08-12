import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import {
  decryptSecret,
  encryptSecret,
  hasEncryptionKeyConfigured,
  maskSecret,
} from 'src/common/crypto/secret-box';
import {
  DEFAULT_MODELS,
  AiProviderId,
  ProviderConfig,
} from './providers/types';
import { getDefaultModels, getProviderAdapter } from './providers';
import { validateModelBaseUrl } from './providers/url-guard';
import {
  FINOS_DEFAULT_MASTER_PROMPT,
  FINOS_IMMUTABLE_SAFETY_LAYER,
  FINOS_PROMPT_VERSION,
  PROVIDER_SETUP_GUIDES,
  buildSystemPrompt,
} from './prompts/finos-master';
import {
  SelectActiveProviderDto,
  UpdateMasterPromptDto,
  UpsertProviderConfigDto,
} from './dto/ai-advisor.dto';

@Injectable()
export class AiSettingsService {
  constructor(
    @Inject('PG_POOL')
    private readonly pgPool: Pool,
  ) {}

  async getSettings(userId: string) {
    const client = await this.pgPool.connect();
    try {
      await this.ensurePreferences(client, userId);
      const prefs = await client.query(
        `SELECT active_provider, active_model, master_prompt, updated_at
         FROM user_ai_preferences WHERE user_id = $1`,
        [userId],
      );
      const configs = await client.query(
        `SELECT id, provider, display_name, model, base_url, project_id, location,
                credentials_meta, is_connected, last_tested_at, last_test_status,
                last_test_message, updated_at
         FROM user_ai_provider_configs
         WHERE user_id = $1 AND deleted_at IS NULL
         ORDER BY provider ASC`,
        [userId],
      );

      const byProvider = new Map(
        configs.rows.map((row) => [row.provider, this.publicConfig(row)]),
      );

      const providers = (
        [
          'openrouter',
          'openai',
          'anthropic',
          'local',
          'vertex',
        ] as AiProviderId[]
      ).map(
        (provider) =>
          byProvider.get(provider) || {
            provider,
            connected: false,
            model: DEFAULT_MODELS[provider][0],
            display_name: null,
            base_url:
              provider === 'local'
                ? 'http://127.0.0.1:11434/v1'
                : provider === 'openrouter'
                  ? 'https://openrouter.ai/api/v1'
                  : null,
            project_id: null,
            location: provider === 'vertex' ? 'us-central1' : null,
            credentials_meta: {},
            last_tested_at: null,
            last_test_status: null,
            last_test_message: null,
            default_models: getDefaultModels(provider),
            setup: PROVIDER_SETUP_GUIDES[provider],
            recommended: provider === 'openrouter',
          },
      );

      const pref = prefs.rows[0];
      return {
        encryption_ready: hasEncryptionKeyConfigured(),
        active_provider: pref?.active_provider || null,
        active_model: pref?.active_model || null,
        master_prompt: pref?.master_prompt || '',
        master_prompt_default: FINOS_DEFAULT_MASTER_PROMPT,
        safety_layer_preview: FINOS_IMMUTABLE_SAFETY_LAYER.slice(0, 280) + '…',
        prompt_version: FINOS_PROMPT_VERSION,
        providers,
        setup_guides: PROVIDER_SETUP_GUIDES,
      };
    } finally {
      client.release();
    }
  }

  async upsertProvider(userId: string, dto: UpsertProviderConfigDto) {
    if (!hasEncryptionKeyConfigured()) {
      throw new BadRequestException(
        'Server is missing AI_CREDENTIALS_ENCRYPTION_KEY.',
      );
    }
    const provider = dto.provider;
    const model =
      dto.model && dto.model !== 'default'
        ? dto.model
        : DEFAULT_MODELS[provider][0];
    const baseUrl =
      provider === 'local' || provider === 'openai'
        ? validateModelBaseUrl(dto.base_url) ||
          (provider === 'local' ? 'http://127.0.0.1:11434/v1' : null)
        : provider === 'openrouter'
          ? 'https://openrouter.ai/api/v1'
          : null;

    const existing = await this.pgPool.query(
      `SELECT * FROM user_ai_provider_configs
       WHERE user_id = $1 AND provider = $2 AND deleted_at IS NULL`,
      [userId, provider],
    );

    let secretPayload: Record<string, string> = {};
    if (existing.rowCount && existing.rows[0].credentials_ciphertext) {
      try {
        secretPayload = JSON.parse(
          decryptSecret({
            ciphertext: existing.rows[0].credentials_ciphertext,
            nonce: existing.rows[0].credentials_nonce,
            tag: existing.rows[0].credentials_tag,
          }),
        );
      } catch {
        secretPayload = {};
      }
    }

    if (dto.api_key) secretPayload.apiKey = dto.api_key.trim();
    let vertexServiceAccount: Record<string, string> | null = null;
    if (dto.service_account_json) {
      try {
        vertexServiceAccount = JSON.parse(dto.service_account_json);
      } catch {
        throw new BadRequestException(
          'Vertex service-account file is not valid JSON.',
        );
      }
      if (
        vertexServiceAccount?.type !== 'service_account' ||
        !vertexServiceAccount?.project_id ||
        !vertexServiceAccount?.client_email ||
        !vertexServiceAccount?.private_key
      ) {
        throw new BadRequestException(
          'Vertex JSON must be a service-account key with project_id, client_email, and private_key.',
        );
      }
      secretPayload.serviceAccountJson = dto.service_account_json.trim();
    }

    if (provider === 'openrouter' && !secretPayload.apiKey) {
      throw new BadRequestException('OpenRouter API key is required.');
    }
    if (provider === 'openai' && !secretPayload.apiKey) {
      throw new BadRequestException('OpenAI API key is required.');
    }
    if (provider === 'anthropic' && !secretPayload.apiKey) {
      throw new BadRequestException('Anthropic API key is required.');
    }
    if (provider === 'vertex' && !secretPayload.serviceAccountJson) {
      throw new BadRequestException('Vertex service-account JSON is required.');
    }

    const encrypted = encryptSecret(JSON.stringify(secretPayload));
    const meta = {
      api_key_masked: maskSecret(secretPayload.apiKey),
      has_api_key: Boolean(secretPayload.apiKey),
      has_service_account: Boolean(secretPayload.serviceAccountJson),
      service_account_email: secretPayload.serviceAccountJson
        ? (() => {
            try {
              return JSON.parse(secretPayload.serviceAccountJson).client_email;
            } catch {
              return null;
            }
          })()
        : null,
    };

    const result = await this.pgPool.query(
      `INSERT INTO user_ai_provider_configs
        (user_id, provider, display_name, model, base_url, project_id, location,
         credentials_ciphertext, credentials_nonce, credentials_tag, credentials_meta,
         is_connected, updated_at, deleted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,false,NOW(),NULL)
       ON CONFLICT (user_id, provider)
       DO UPDATE SET
         display_name = EXCLUDED.display_name,
         model = EXCLUDED.model,
         base_url = EXCLUDED.base_url,
         project_id = EXCLUDED.project_id,
         location = EXCLUDED.location,
         credentials_ciphertext = EXCLUDED.credentials_ciphertext,
         credentials_nonce = EXCLUDED.credentials_nonce,
         credentials_tag = EXCLUDED.credentials_tag,
         credentials_meta = EXCLUDED.credentials_meta,
         deleted_at = NULL,
         updated_at = NOW()
       RETURNING id, provider, display_name, model, base_url, project_id, location,
                 credentials_meta, is_connected, last_tested_at, last_test_status,
                 last_test_message, updated_at`,
      [
        userId,
        provider,
        dto.display_name || null,
        model,
        baseUrl,
        dto.project_id || vertexServiceAccount?.project_id || null,
        dto.location || (provider === 'vertex' ? 'us-central1' : null),
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.tag,
        JSON.stringify(meta),
      ],
    );

    await this.ensurePreferences(this.pgPool, userId);
    await this.pgPool.query(
      `UPDATE user_ai_preferences
       SET active_provider = $2, active_model = $3, updated_at = NOW()
       WHERE user_id = $1 AND active_provider IS NULL`,
      [userId, provider, model],
    );
    return {
      ...this.publicConfig(result.rows[0]),
      default_models: getDefaultModels(provider),
      setup: PROVIDER_SETUP_GUIDES[provider],
      recommended: provider === 'openrouter',
    };
  }

  async disconnectProvider(userId: string, provider: AiProviderId) {
    const result = await this.pgPool.query(
      `UPDATE user_ai_provider_configs
       SET deleted_at = NOW(),
           is_connected = FALSE,
           credentials_ciphertext = NULL,
           credentials_nonce = NULL,
           credentials_tag = NULL,
           credentials_meta = '{}'::jsonb,
           updated_at = NOW()
       WHERE user_id = $1 AND provider = $2 AND deleted_at IS NULL
       RETURNING provider`,
      [userId, provider],
    );
    if (!result.rowCount) {
      throw new NotFoundException('Provider config not found');
    }
    await this.pgPool.query(
      `UPDATE user_ai_preferences
       SET active_provider = CASE WHEN active_provider = $2 THEN NULL ELSE active_provider END,
           active_model = CASE WHEN active_provider = $2 THEN NULL ELSE active_model END,
           updated_at = NOW()
       WHERE user_id = $1`,
      [userId, provider],
    );
    return { provider, disconnected: true };
  }

  async selectActive(userId: string, dto: SelectActiveProviderDto) {
    const config = await this.loadProviderConfig(userId, dto.provider);
    if (!config) {
      throw new BadRequestException(
        `Connect ${dto.provider} in Settings before selecting it.`,
      );
    }
    const model = dto.model || config.model;
    await this.pgPool.query(
      `UPDATE user_ai_provider_configs
       SET model = $3, updated_at = NOW()
       WHERE user_id = $1 AND provider = $2 AND deleted_at IS NULL`,
      [userId, dto.provider, model],
    );
    await this.ensurePreferences(this.pgPool, userId);
    await this.pgPool.query(
      `UPDATE user_ai_preferences
       SET active_provider = $2, active_model = $3, updated_at = NOW()
       WHERE user_id = $1`,
      [userId, dto.provider, model],
    );
    return { active_provider: dto.provider, active_model: model };
  }

  async updateMasterPrompt(userId: string, dto: UpdateMasterPromptDto) {
    await this.ensurePreferences(this.pgPool, userId);
    const value = (dto.master_prompt || '').trim();
    await this.pgPool.query(
      `UPDATE user_ai_preferences
       SET master_prompt = $2, updated_at = NOW()
       WHERE user_id = $1`,
      [userId, value || null],
    );
    return {
      master_prompt: value,
      composed_preview: buildSystemPrompt(value).slice(0, 500) + '…',
    };
  }

  async testProvider(userId: string, provider: AiProviderId) {
    const config = await this.loadProviderConfig(userId, provider);
    if (!config) {
      throw new BadRequestException('Save provider credentials first.');
    }
    const adapter = getProviderAdapter(provider);
    const result = await adapter.testConnection(config);
    await this.pgPool.query(
      `UPDATE user_ai_provider_configs
       SET is_connected = $3,
           last_tested_at = NOW(),
           last_test_status = $4,
           last_test_message = $5,
           updated_at = NOW()
       WHERE user_id = $1 AND provider = $2 AND deleted_at IS NULL`,
      [
        userId,
        provider,
        result.ok,
        result.ok ? 'ok' : 'failed',
        result.message,
      ],
    );
    if (result.ok) {
      await this.ensurePreferences(this.pgPool, userId);
      const prefs = await this.pgPool.query(
        `SELECT active_provider FROM user_ai_preferences WHERE user_id = $1`,
        [userId],
      );
      if (!prefs.rows[0]?.active_provider) {
        await this.pgPool.query(
          `UPDATE user_ai_preferences
           SET active_provider = $2, active_model = $3, updated_at = NOW()
           WHERE user_id = $1`,
          [userId, provider, config.model],
        );
      }
    }
    return result;
  }

  async listModels(userId: string, provider: AiProviderId) {
    const defaults = getDefaultModels(provider);
    const config = await this.loadProviderConfig(userId, provider);
    if (!config) return { models: defaults, source: 'defaults' };
    const adapter = getProviderAdapter(provider);
    const discovered = adapter.listModels
      ? await adapter.listModels(config)
      : [];
    // Keep curated defaults first so the UI highlights recommended slugs.
    const merged = [...new Set([...defaults, ...discovered])];
    return {
      models: merged,
      source: discovered.length ? 'provider' : 'defaults',
    };
  }

  async loadActiveProviderConfig(userId: string): Promise<{
    config: ProviderConfig;
    masterPrompt: string | null;
  }> {
    await this.ensurePreferences(this.pgPool, userId);
    const prefs = await this.pgPool.query(
      `SELECT active_provider, active_model, master_prompt
       FROM user_ai_preferences WHERE user_id = $1`,
      [userId],
    );
    const provider = prefs.rows[0]?.active_provider as AiProviderId | undefined;
    if (!provider) {
      throw new BadRequestException(
        'No active AI provider. Connect and select one in Settings → AI & Models.',
      );
    }
    const config = await this.loadProviderConfig(userId, provider);
    if (!config) {
      throw new BadRequestException(
        `Active provider (${provider}) is not connected.`,
      );
    }
    if (prefs.rows[0]?.active_model) {
      config.model = prefs.rows[0].active_model;
    }
    return {
      config,
      masterPrompt: prefs.rows[0]?.master_prompt || null,
    };
  }

  async loadProviderConfig(
    userId: string,
    provider: AiProviderId,
  ): Promise<ProviderConfig | null> {
    const result = await this.pgPool.query(
      `SELECT * FROM user_ai_provider_configs
       WHERE user_id = $1 AND provider = $2 AND deleted_at IS NULL`,
      [userId, provider],
    );
    if (!result.rowCount || !result.rows[0].credentials_ciphertext) return null;
    const row = result.rows[0];
    let credentials: ProviderConfig['credentials'] = {};
    try {
      credentials = JSON.parse(
        decryptSecret({
          ciphertext: row.credentials_ciphertext,
          nonce: row.credentials_nonce,
          tag: row.credentials_tag,
        }),
      );
    } catch {
      throw new BadRequestException(
        'Stored credentials could not be decrypted. Re-save the provider key.',
      );
    }
    return {
      provider,
      model: row.model || DEFAULT_MODELS[provider][0],
      baseUrl: row.base_url,
      projectId: row.project_id,
      location: row.location,
      credentials: {
        ...credentials,
        projectId: row.project_id || credentials.projectId,
        location: row.location || credentials.location,
        baseUrl: row.base_url || credentials.baseUrl,
      },
    };
  }

  private publicConfig(row: any) {
    const provider = row.provider as AiProviderId;
    return {
      id: row.id,
      provider,
      connected: Boolean(row.is_connected),
      display_name: row.display_name,
      model: row.model,
      base_url: row.base_url,
      project_id: row.project_id,
      location: row.location,
      credentials_meta: row.credentials_meta || {},
      last_tested_at: row.last_tested_at,
      last_test_status: row.last_test_status,
      last_test_message: row.last_test_message,
      updated_at: row.updated_at,
      default_models: getDefaultModels(provider),
      setup: PROVIDER_SETUP_GUIDES[provider],
      recommended: provider === 'openrouter',
    };
  }

  private async ensurePreferences(client: any, userId: string) {
    await client.query(
      `INSERT INTO user_ai_preferences (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
  }
}
