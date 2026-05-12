/**
 * @file ProjectConversationService.ts — orchestration layer.
 * @description Coordinates local storage and the remote API to manage project-scoped
 *   conversation bindings and bot-member sync.
 * @depends conversation/ConversationBindingStore, conversation/ConversationBindingRemoteClient
 */

import type {
  ProjectConversationBindingDTO,
  ProjectConversationBindingChangedEvent,
  ProjectConversationCreateParams,
  ProjectConversationListParams,
  ProjectConversationResolveParams,
} from '../../../shared/api-types';
import { Emitter, type Event } from '../../../shared/utils';
import WebSocketImpl from '../utils/ws';
import { createElectronMainIMAdapter } from '@scipen/im-adapter-electron-main';
import { createLogger } from './LoggerService';
import { ServiceNames, getServiceContainer, type IDisposable } from './ServiceContainer';
import type { StudioIMService } from './StudioIMService';
import type { StudioOTService } from './StudioOTService';
import {
  ConversationBindingStore,
  toDto,
  buildScopeKey,
  resolveTitle,
  normalizeLocalRootPath,
  normalizeWorkspaceId,
} from './conversation/ConversationBindingStore';
import {
  ConversationBindingRemoteClient,
  isRouteMissing,
  type IMConnectionConfig,
} from './conversation/ConversationBindingRemoteClient';

const logger = createLogger('ProjectConversationService');

/** True when the error is 403/404 (remote project missing or not permitted). */
function isNotFoundOrForbidden(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /\b(403|404)\b/.test(msg);
}

export class ProjectConversationService implements IDisposable {
  private readonly store = new ConversationBindingStore();
  private _remote: ConversationBindingRemoteClient | null = null;
  private _staleConversationCleanup: IDisposable | null = null;

  private readonly _onDidChangeBinding = new Emitter<ProjectConversationBindingChangedEvent>();
  readonly onDidChangeBinding: Event<ProjectConversationBindingChangedEvent> =
    this._onDidChangeBinding.event;

  constructor() {
    this._staleConversationCleanup = this.getIMService().onDidDetectStaleConversation(
      (conversationId) => {
        void this.handleStaleConversation(conversationId);
      }
    );
  }

  private get remote(): ConversationBindingRemoteClient {
    if (!this._remote) {
      const adapter = createElectronMainIMAdapter(WebSocketImpl);
      this._remote = new ConversationBindingRemoteClient(adapter.http);
    }
    return this._remote;
  }

  private lastImConfig: IMConnectionConfig | null = null;
  private hasWarnedAboutMissingRoute = false;
  private warnedMemberConversationIds = new Set<string>();

  // ====== Public API ======

  async resolveBinding(
    params: ProjectConversationResolveParams
  ): Promise<ProjectConversationBindingDTO | null> {
    this.cacheIMConfig(params.imConfig);
    if (this.shouldUseLocalPathScope(params)) {
      const binding = await this.resolveLocal(params);
      await this.syncBotMembers(binding, params.projectId ?? null, params.imConfig);
      return binding;
    }
    const botUserId = await this.resolveBotUserId(params.imConfig.baseUrl, params.imConfig.token);

    try {
      const binding = await this.remote.resolve(params.imConfig, {
        ...params,
        botUserId,
      });
      await this.syncBotMembers(binding, params.projectId ?? null, params.imConfig);
      return binding;
    } catch (error) {
      const binding = await this.tryResolveLocalFallback(params, error);
      if (binding !== undefined) {
        await this.syncBotMembers(binding, params.projectId ?? null, params.imConfig);
        return binding;
      }
      throw error;
    }
  }

  async listBindings(
    params: ProjectConversationListParams
  ): Promise<ProjectConversationBindingDTO[]> {
    if (this.shouldUseLocalPathScope(params)) {
      return this.store.list(params);
    }
    const imConfig = this.requireIMConfig();
    try {
      return await this.remote.list(imConfig, params);
    } catch (error) {
      if (!isRouteMissing(error)) throw error;
      return this.store.list(params);
    }
  }

  async createBinding(
    params: ProjectConversationCreateParams
  ): Promise<ProjectConversationBindingDTO> {
    this.cacheIMConfig(params.imConfig);
    let binding: ProjectConversationBindingDTO;
    let firedByCreateLocal = false;
    if (this.shouldUseLocalPathScope(params)) {
      binding = await this.createLocal(params); // createLocal already fires internally.
      firedByCreateLocal = true;
    } else {
      const botUserId = await this.resolveBotUserId(params.imConfig.baseUrl, params.imConfig.token);
      try {
        binding = await this.remote.create(params.imConfig, { ...params, botUserId });
      } catch (error) {
        const fallback = await this.tryCreateLocalFallback(params, error);
        if (fallback) {
          binding = fallback;
          firedByCreateLocal = true; // tryCreateLocalFallback -> createLocal already fired.
        } else {
          throw error;
        }
      }
    }
    await this.syncBotMembers(binding, params.projectId ?? null, params.imConfig);
    if (!firedByCreateLocal) {
      this.fireBindingChanged(binding, params, 'created');
    }
    return binding;
  }

  async setDefaultBinding(bindingId: string): Promise<void> {
    const imConfig = this.requireIMConfig();
    try {
      await this.remote.setDefault(imConfig, bindingId);
    } catch (error) {
      if (!isRouteMissing(error)) throw error;
      await this.store.setDefault(bindingId);
    }
    this._onDidChangeBinding.fire({
      runtime: 'openclaw',
      scopeType: 'global',
      projectId: null,
      localRootPath: null,
      workspaceId: null,
      bindingId,
      reason: 'set_default',
    });
  }

  dispose(): void {
    this._staleConversationCleanup?.dispose();
    this._staleConversationCleanup = null;
    this._onDidChangeBinding.dispose();
    this.warnedMemberConversationIds.clear();
    this._remote = null;
  }

  private async handleStaleConversation(conversationId: string): Promise<void> {
    const deleted = await this.store.deleteByConversationId(conversationId);
    if (!deleted) return;
    logger.info(`[ProjectConversationService] Stale binding deleted: ${conversationId}`);
    this._onDidChangeBinding.fire({
      runtime: 'openclaw',
      scopeType: (deleted.scopeType as 'global' | 'project') || 'project',
      projectId: deleted.projectId ?? null,
      localRootPath: deleted.localRootPath ?? null,
      workspaceId: deleted.workspaceId ?? null,
      bindingId: deleted.id,
      reason: 'deleted',
    });
  }

  private fireBindingChanged(
    binding: ProjectConversationBindingDTO,
    params: {
      scopeType: 'global' | 'project';
      projectId?: string | null;
      localRootPath?: string | null;
      workspaceId?: string | null;
    },
    reason: 'created' | 'set_default' | 'updated'
  ): void {
    this._onDidChangeBinding.fire({
      runtime: 'openclaw',
      scopeType: params.scopeType,
      projectId: params.projectId ?? null,
      localRootPath: params.localRootPath ?? null,
      workspaceId: params.workspaceId ?? null,
      bindingId: binding.id,
      reason,
    });
  }

  // ====== IM Config ======

  private cacheIMConfig(imConfig: IMConnectionConfig): void {
    this.lastImConfig = {
      baseUrl: imConfig.baseUrl.replace(/\/+$/, ''),
      token: imConfig.token.trim(),
    };
  }

  private requireIMConfig(): IMConnectionConfig {
    if (this.lastImConfig?.baseUrl && this.lastImConfig?.token) {
      return this.lastImConfig;
    }
    const current = this.getIMService().getConfig();
    if (current?.baseUrl && current?.token) {
      this.lastImConfig = {
        baseUrl: current.baseUrl.replace(/\/+$/, ''),
        token: current.token.trim(),
      };
      return this.lastImConfig;
    }
    throw new Error('IM 配置缺失，无法访问项目会话服务');
  }

  private warnRouteMissing(): void {
    if (this.hasWarnedAboutMissingRoute) return;
    logger.warn(
      'assistant-conversations is not available on the current IM service; falling back to local binding storage'
    );
    this.hasWarnedAboutMissingRoute = true;
  }

  private shouldPreferProjectLocalFallback(params: {
    scopeType: 'global' | 'project';
    localRootPath?: string | null;
  }): boolean {
    return params.scopeType === 'project' && !!params.localRootPath?.trim();
  }

  private async tryResolveLocalFallback(
    params: ProjectConversationResolveParams,
    error: unknown
  ): Promise<ProjectConversationBindingDTO | null | undefined> {
    if (isRouteMissing(error)) {
      this.warnRouteMissing();
      return await this.resolveLocal(params);
    }
    if (this.shouldPreferProjectLocalFallback(params) && isNotFoundOrForbidden(error)) {
      logger.warn(
        `Remote project binding resolve returned 403/404, falling back to local project binding: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return await this.resolveLocal(params);
    }
    return undefined;
  }

  private async tryCreateLocalFallback(
    params: ProjectConversationCreateParams,
    error: unknown
  ): Promise<ProjectConversationBindingDTO | undefined> {
    if (isRouteMissing(error)) {
      this.warnRouteMissing();
      return await this.createLocal(params);
    }
    if (this.shouldPreferProjectLocalFallback(params) && isNotFoundOrForbidden(error)) {
      logger.warn(
        `Remote project binding create returned 403/404, falling back to local project binding: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return await this.createLocal(params);
    }
    return undefined;
  }

  private shouldUseLocalPathScope(params: {
    scopeType: 'global' | 'project';
    projectId?: string | null;
    localRootPath?: string | null;
  }): boolean {
    return (
      params.scopeType === 'project' && !params.projectId?.trim() && !!params.localRootPath?.trim()
    );
  }

  // ====== Local Fallback ======

  private async resolveLocal(
    params: ProjectConversationResolveParams
  ): Promise<ProjectConversationBindingDTO | null> {
    const existing = await this.store.findBest(params);
    if (existing) {
      await this.store.touch(existing, params);
      return toDto((await this.store.findById(existing.id)) ?? existing);
    }
    if (!params.createIfMissing) return null;
    return this.createLocal({
      runtime: params.runtime,
      scopeType: params.scopeType,
      projectId: params.projectId ?? null,
      localRootPath: params.localRootPath ?? null,
      workspaceId: params.workspaceId ?? null,
      title: params.title ?? null,
      imConfig: params.imConfig,
    });
  }

  private async createLocal(
    params: ProjectConversationCreateParams
  ): Promise<ProjectConversationBindingDTO> {
    if (!params.imConfig.baseUrl || !params.imConfig.token) {
      throw new Error('IM 连接未配置，无法创建项目对话');
    }

    // Second dedupe pass: guard against duplicates created in the resolveLocal -> createLocal gap.
    const existing = await this.store.findBest(params);
    if (existing) {
      await this.store.touch(existing, {
        projectId: params.projectId ?? null,
        localRootPath: params.localRootPath ?? null,
        workspaceId: params.workspaceId ?? null,
        title: params.title ?? null,
      });
      await this.store.setDefault(existing.id);
      return toDto((await this.store.findById(existing.id)) ?? existing);
    }

    const botUserId = await this.resolveBotUserId(params.imConfig.baseUrl, params.imConfig.token);
    const scopeKey = buildScopeKey(params.scopeType, params.projectId, params.localRootPath);
    const title = resolveTitle(
      params.scopeType,
      params.title,
      params.projectId,
      params.localRootPath
    );

    let conversation;
    try {
      conversation = await this.getIMService().createConversation({
        baseUrl: params.imConfig.baseUrl,
        token: params.imConfig.token,
        type: 'group',
        memberIds: [botUserId],
        title,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `创建项目会话失败。已选择 bot 用户 ${botUserId}，但 IM Server 创建会话返回错误：${message}`
      );
    }

    await this.store.clearDefaults(
      params.runtime,
      params.scopeType,
      params.projectId ?? null,
      params.localRootPath ?? null,
      params.workspaceId ?? null
    );

    const binding = await this.store.insert({
      conversationId: conversation.id,
      runtime: params.runtime,
      scopeType: params.scopeType,
      scopeKey,
      projectId: params.projectId ?? null,
      localRootPath: normalizeLocalRootPath(params.localRootPath),
      workspaceId: normalizeWorkspaceId(params.workspaceId ?? null),
      title: conversation.title || title,
      isDefault: true,
    });
    this.fireBindingChanged(binding, params, 'created');
    return binding;
  }

  // ====== Bot Member Sync ======

  private async syncBotMembers(
    binding: ProjectConversationBindingDTO | null,
    projectId: string | null,
    imConfig: IMConnectionConfig
  ): Promise<void> {
    if (!binding || !projectId) return;

    try {
      const members = await this.getIMService().getConversationMembersForConfig(
        imConfig.baseUrl,
        imConfig.token,
        binding.conversationId
      );
      const botIds = [...new Set(members.filter((m) => m.role === 'bot').map((m) => m.user_id))];
      const otService = this.getOTService();

      logger.info(`syncBotMembers: found ${botIds.length} bot users for project ${projectId}`);
      for (const botUserId of botIds) {
        try {
          await otService.addProjectMember(projectId, botUserId, 'editor');
          logger.info(`syncBotMembers: bot ${botUserId} added as editor for project ${projectId}`);
        } catch (error) {
          logger.warn(
            `syncBotMembers: failed to add bot ${botUserId} to project ${projectId}:`,
            error
          );
        }
      }
    } catch (error) {
      if (!this.warnedMemberConversationIds.has(binding.conversationId)) {
        logger.info(
          `Failed to read members for conversation ${binding.conversationId}; skipping bot sync for legacy IM compatibility.`,
          error
        );
        if (this.warnedMemberConversationIds.size > 500) this.warnedMemberConversationIds.clear();
        this.warnedMemberConversationIds.add(binding.conversationId);
      }
    }
  }

  private async resolveBotUserId(baseUrl: string, token: string): Promise<string> {
    const users = await this.getIMService().listUsersForConfig(baseUrl, token);
    const bots = users.filter((user) => user.role === 'bot');
    if (bots.length === 1) {
      logger.info(`Auto-discovered bot user ${bots[0].id}`);
      return bots[0].id;
    }
    if (bots.length === 0) {
      throw new Error('IM 里没有 bot 用户，无法自动创建项目对话');
    }
    throw new Error(
      'IM 中存在多个 bot 用户，当前产品模式不支持从 Studio 端选择 bot，请联系管理员整理工作区 bot 配置'
    );
  }

  // ====== Service Access ======

  private getIMService(): StudioIMService {
    return getServiceContainer().get<StudioIMService>(ServiceNames.STUDIO_IM);
  }

  private getOTService(): StudioOTService {
    return getServiceContainer().get<StudioOTService>(ServiceNames.STUDIO_OT);
  }
}
