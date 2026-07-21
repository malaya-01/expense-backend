import { BadRequestException } from '@nestjs/common';
import { GoogleAuth } from 'google-auth-library';
import {
  AiProviderAdapter,
  ProviderChatRequest,
  ProviderChatResult,
  ProviderConfig,
} from './types';

export class VertexAdapter implements AiProviderAdapter {
  readonly id = 'vertex' as const;

  private async getAccessToken(serviceAccountJson: string): Promise<string> {
    let credentials: Record<string, unknown>;
    try {
      credentials = JSON.parse(serviceAccountJson);
    } catch {
      throw new BadRequestException('Vertex service-account JSON is invalid.');
    }
    if (!credentials.client_email || !credentials.private_key) {
      throw new BadRequestException(
        'Service-account JSON must include client_email and private_key.',
      );
    }
    const auth = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const client = await auth.getClient();
    const token = await client.getAccessToken();
    if (!token?.token) {
      throw new BadRequestException('Could not obtain Vertex access token.');
    }
    return token.token;
  }

  private requestBody(request: ProviderChatRequest) {
    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const contents = request.messages
      .filter(
        (message) =>
          message.role === 'user' || message.role === 'assistant',
      )
      .map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [
          { text: message.content },
          ...(message.attachments || []).map((file) => ({
            inlineData: {
              mimeType: file.mimeType,
              data: file.dataBase64,
            },
          })),
        ],
      }));
    return {
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents,
      generationConfig: {
        temperature: request.temperature ?? 0.3,
        maxOutputTokens: request.maxTokens ?? 2048,
      },
    };
  }

  private resolveProject(config: ProviderConfig, serviceAccountJson: string) {
    const projectId =
      config.projectId ||
      config.credentials.projectId ||
      (() => {
        try {
          return JSON.parse(serviceAccountJson).project_id as string;
        } catch {
          return '';
        }
      })();
    if (!projectId) {
      throw new BadRequestException('Vertex project id is required.');
    }
    return {
      projectId,
      location:
        config.location || config.credentials.location || 'us-central1',
    };
  }

  async chat(
    config: ProviderConfig,
    request: ProviderChatRequest,
  ): Promise<ProviderChatResult> {
    const sa = config.credentials.serviceAccountJson;
    if (!sa) {
      throw new BadRequestException('Vertex service-account JSON is required.');
    }
    const { projectId, location } = this.resolveProject(config, sa);

    const accessToken = await this.getAccessToken(sa);
    const model = request.model || config.model;
    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(this.requestBody(request)),
    });

    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const err = await res.json();
        message = err?.error?.message || message;
      } catch {
        /* ignore */
      }
      throw new BadRequestException(`Provider error (vertex): ${message}`);
    }

    const data = await res.json();
    const content = (data?.candidates?.[0]?.content?.parts || [])
      .map((p: any) => p.text || '')
      .join('')
      .trim();
    if (!content) {
      throw new BadRequestException('Vertex returned an empty response.');
    }
    return {
      content,
      model,
      provider: 'vertex',
      usage: {
        input_tokens: data?.usageMetadata?.promptTokenCount,
        output_tokens: data?.usageMetadata?.candidatesTokenCount,
      },
    };
  }

  async *streamChat(
    config: ProviderConfig,
    request: ProviderChatRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<string, ProviderChatResult, void> {
    const sa = config.credentials.serviceAccountJson;
    if (!sa) {
      throw new BadRequestException('Vertex service-account JSON is required.');
    }
    const { projectId, location } = this.resolveProject(config, sa);
    const accessToken = await this.getAccessToken(sa);
    const model = request.model || config.model;
    const url =
      `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}` +
      `/locations/${location}/publishers/google/models/${model}` +
      ':streamGenerateContent?alt=sse';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      signal,
      body: JSON.stringify(this.requestBody(request)),
    });
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const error = await res.json();
        message = error?.error?.message || message;
      } catch {
        /* ignore */
      }
      throw new BadRequestException(`Provider error (vertex): ${message}`);
    }
    if (!res.body) {
      throw new BadRequestException('Vertex returned an empty stream.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        try {
          const data = JSON.parse(line.slice(5).trim());
          const delta = (data?.candidates?.[0]?.content?.parts || [])
            .filter((part: any) => !part.thought)
            .map((part: any) => part.text || '')
            .join('');
          if (delta) {
            content += delta;
            yield delta;
          }
        } catch {
          /* wait for the next complete SSE frame */
        }
      }
    }
    if (!content) {
      throw new BadRequestException('Vertex returned an empty response.');
    }
    return { content, model, provider: 'vertex' };
  }

  async testConnection(config: ProviderConfig) {
    try {
      const result = await this.chat(config, {
        model: config.model,
        messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
        // Gemini 2.5 may consume a small token budget for internal reasoning
        // before emitting text, so a 16-token health check can look empty.
        maxTokens: 256,
        temperature: 0,
      });
      return {
        ok: true,
        message: `Connected to Vertex AI (${result.model}).`,
        model: result.model,
      };
    } catch (error: any) {
      return { ok: false, message: error?.message || 'Connection failed' };
    }
  }

  async listModels(config: ProviderConfig): Promise<string[]> {
    const sa = config.credentials.serviceAccountJson;
    if (!sa) return [];
    const credentials = JSON.parse(sa) as { project_id?: string };
    const projectId =
      config.projectId || config.credentials.projectId || credentials.project_id;
    const location =
      config.location || config.credentials.location || 'us-central1';
    if (!projectId) return [];

    try {
      const token = await this.getAccessToken(sa);
      const url =
        `https://${location}-aiplatform.googleapis.com/v1/projects/` +
        `${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}` +
        '/publishers/google/models?pageSize=100';
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return [];
      const data = await res.json();
      return (data?.publisherModels || data?.models || [])
        .map((item: any) => String(item?.name || item?.displayName || ''))
        .map((name: string) => name.split('/').pop() || '')
        .filter((name: string) => name.startsWith('gemini-'))
        .map((name: string) => name.replace(/@.+$/, ''))
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}

export const vertexAdapter = new VertexAdapter();
