/**
 * @file ConversationBindingRemoteClient.ts — remote REST API client.
 * @description Talks to the IM Server's /api/assistant-conversations endpoints through an
 *   injected IHttpClient, keeping the architecture aligned with the IM communication layer.
 */

import type { IHttpClient } from '@scipen/im-core';
import type {
  ProjectConversationBindingDTO,
  ProjectConversationCreateParams,
  ProjectConversationListParams,
  ProjectConversationResolveParams,
} from '../../../../shared/api-types';
import { normalizeLocalRootPath } from './ConversationBindingStore';

// ====== Response Types ======

interface BindingResponse {
  binding: ProjectConversationBindingDTO | null;
}

interface BindingsResponse {
  bindings: ProjectConversationBindingDTO[];
}

interface ErrorPayload {
  error?: { code?: string; message?: string };
}

// ====== Error ======

export class ConversationRemoteError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

export function isRouteMissing(error: unknown): error is ConversationRemoteError {
  return error instanceof ConversationRemoteError && error.statusCode === 404;
}

// ====== Config ======

export interface IMConnectionConfig {
  baseUrl: string;
  token: string;
}

interface ResolveAssistantConversationRequest extends ProjectConversationResolveParams {
  botUserId?: string | null;
}

interface CreateAssistantConversationRequest extends ProjectConversationCreateParams {
  botUserId?: string | null;
}

function normalizeConfig(config: IMConnectionConfig): IMConnectionConfig {
  return {
    baseUrl: config.baseUrl.replace(/\/+$/, ''),
    token: config.token.trim(),
  };
}

function buildQuery(params: Record<string, string | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') {
      query.set(key, value);
    }
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : '';
}

// ====== Client ======

export class ConversationBindingRemoteClient {
  constructor(private readonly http: IHttpClient) {}

  async resolve(
    imConfig: IMConnectionConfig,
    params: ResolveAssistantConversationRequest
  ): Promise<ProjectConversationBindingDTO | null> {
    const payload = await this.post<BindingResponse>(
      imConfig,
      '/api/assistant-conversations/resolve',
      {
        runtime: params.runtime,
        scopeType: params.scopeType,
        projectId: params.projectId ?? null,
        localRootPath: normalizeLocalRootPath(params.localRootPath),
        workspaceId: params.workspaceId ?? null,
        title: params.title ?? null,
        createIfMissing: params.createIfMissing ?? true,
        botUserId: params.botUserId ?? null,
      }
    );
    return payload.binding;
  }

  async create(
    imConfig: IMConnectionConfig,
    params: CreateAssistantConversationRequest
  ): Promise<ProjectConversationBindingDTO> {
    const payload = await this.post<BindingResponse>(imConfig, '/api/assistant-conversations', {
      runtime: params.runtime,
      scopeType: params.scopeType,
      projectId: params.projectId ?? null,
      localRootPath: normalizeLocalRootPath(params.localRootPath),
      workspaceId: params.workspaceId ?? null,
      title: params.title ?? null,
      botUserId: params.botUserId ?? null,
    });
    if (!payload.binding) {
      throw new Error('Assistant conversation creation returned empty binding');
    }
    return payload.binding;
  }

  async list(
    imConfig: IMConnectionConfig,
    params: ProjectConversationListParams
  ): Promise<ProjectConversationBindingDTO[]> {
    const payload = await this.get<BindingsResponse>(
      imConfig,
      `/api/assistant-conversations${buildQuery({
        runtime: params.runtime,
        scopeType: params.scopeType,
        projectId: params.projectId ?? null,
        workspaceId: null,
      })}`
    );
    return payload.bindings || [];
  }

  async setDefault(imConfig: IMConnectionConfig, bindingId: string): Promise<void> {
    await this.post<BindingResponse>(
      imConfig,
      `/api/assistant-conversations/${encodeURIComponent(bindingId)}/default`,
      {}
    );
  }

  private async get<T>(imConfig: IMConnectionConfig, pathName: string): Promise<T> {
    const config = normalizeConfig(imConfig);
    const resp = await this.http.request(`${config.baseUrl}${pathName}`, {
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
    });
    if (!resp.ok) {
      throw await this.buildError(resp, 'GET', pathName);
    }
    return resp.json<T>();
  }

  private async post<T>(imConfig: IMConnectionConfig, pathName: string, body: unknown): Promise<T> {
    const config = normalizeConfig(imConfig);
    const resp = await this.http.request(`${config.baseUrl}${pathName}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw await this.buildError(resp, 'POST', pathName);
    }
    return resp.json<T>();
  }

  private async buildError(
    resp: { ok: boolean; status: number; statusText: string; json<T>(): Promise<T> },
    method: string,
    pathName: string
  ): Promise<ConversationRemoteError> {
    let payload: ErrorPayload | null = null;
    try {
      payload = await resp.json<ErrorPayload>();
    } catch {
      payload = null;
    }
    const message =
      payload?.error?.message ||
      `IM API ${method} ${pathName} failed: ${resp.status} ${resp.statusText}`;
    return new ConversationRemoteError(resp.status, message);
  }
}
