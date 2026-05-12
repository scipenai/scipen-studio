import { createLogger } from './LoggerService';
import { ReconnectManager } from '../utils/ReconnectManager';
import { Emitter, type Event } from '../../../shared/utils';
import WebSocketImpl from '../utils/ws';
import { IMCore } from '@scipen/im-core';
import { createElectronMainIMAdapter } from '@scipen/im-adapter-electron-main';
import type { ConversationWithMeta, MessageMetadata, User } from '@scipen/im-protocol';
import type {
  IMConnectionStateDTO,
  IMErrorDTO,
  IMMessagesChangedDTO,
  IMSnapshot,
  IMTypingDTO,
  StudioIMConnectParams,
  StudioIMConversationDTO,
  StudioIMCreateConversationParams,
  StudioIMListConversationsParams,
  StudioIMMessageDTO,
  StudioIMSendMessageParams,
  StudioIMUploadAttachmentParams,
  StudioIMUploadAttachmentResult,
} from '../../../shared/api-types';

const logger = createLogger('StudioIMService');
const MESSAGE_PAGE_SIZE = 50;
const POLL_INTERVAL_DISCONNECTED_MS = 2000;
const POLL_INTERVAL_CONNECTED_MS = 30_000;
const TYPING_TTL_MS = 5000;
const MAX_RECONNECT_ATTEMPTS = 15;
const BASE_RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const POLL_FAILURE_THRESHOLD = 5;
/** Delay before propagating a WebSocket downgrade to the UI, avoiding flicker on brief drops. */
const STATE_DOWNGRADE_DELAY_MS = 3_000;

function mergeMessages(
  current: StudioIMMessageDTO[],
  incoming: StudioIMMessageDTO[]
): StudioIMMessageDTO[] {
  const merged = new Map<string, StudioIMMessageDTO>();
  for (const message of current) merged.set(message.id, message);
  for (const message of incoming) merged.set(message.id, message);
  return Array.from(merged.values()).sort(
    (left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime()
  );
}

/** Cheap check for substantive change between two message arrays (length + last id/content). */
function messagesEqual(a: StudioIMMessageDTO[], b: StudioIMMessageDTO[]): boolean {
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  const lastA = a[a.length - 1];
  const lastB = b[b.length - 1];
  return lastA.id === lastB.id && lastA.content === lastB.content;
}

function emptySnapshot(): IMSnapshot {
  return {
    conversationId: '',
    state: 'disconnected',
    lastSyncedAt: null,
    messages: [],
    typingUserIds: [],
  };
}

export class StudioIMService {
  private core: IMCore | null = null;
  private config: StudioIMConnectParams | null = null;
  private snapshot: IMSnapshot = emptySnapshot();
  private typingEntries = new Map<string, { expiresAt: number }>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private consecutivePollFailures = 0;
  /** Timer that delays propagating a downgrade to the UI when WebSocket drops briefly. */
  private wsDowngradeTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly reconnect = new ReconnectManager({
    maxAttempts: MAX_RECONNECT_ATTEMPTS,
    baseDelayMs: BASE_RECONNECT_DELAY_MS,
    maxDelayMs: MAX_RECONNECT_DELAY_MS,
    label: 'StudioIMService',
    logger,
    onReconnect: () => this.performReconnect(),
  });

  private readonly _onDidChangeState = new Emitter<IMConnectionStateDTO>();
  readonly onDidChangeState: Event<IMConnectionStateDTO> = this._onDidChangeState.event;

  private readonly _onDidChangeMessages = new Emitter<IMMessagesChangedDTO>();
  readonly onDidChangeMessages: Event<IMMessagesChangedDTO> = this._onDidChangeMessages.event;

  private readonly _onDidChangeTyping = new Emitter<IMTypingDTO>();
  readonly onDidChangeTyping: Event<IMTypingDTO> = this._onDidChangeTyping.event;

  private readonly _onDidError = new Emitter<IMErrorDTO>();
  readonly onDidError: Event<IMErrorDTO> = this._onDidError.event;

  private readonly _onDidDetectStaleConversation = new Emitter<string>();
  readonly onDidDetectStaleConversation: Event<string> = this._onDidDetectStaleConversation.event;

  getConfig(): StudioIMConnectParams | null {
    return this.config;
  }

  getSnapshot(): IMSnapshot {
    return {
      ...this.snapshot,
      messages: [...this.snapshot.messages],
      typingUserIds: [...this.snapshot.typingUserIds],
    };
  }

  private createCore(baseUrl: string, token: string): IMCore {
    const adapter = createElectronMainIMAdapter(WebSocketImpl);
    return new IMCore({ baseUrl, token, autoReconnect: false }, adapter);
  }

  /**
   * Only reuse the existing connection when both the config matches and the core is still
   * live. disconnect() clears core but keeps config; config-only equality would treat a
   * disconnected connection as reusable and later sendMessage would hit `IM is not configured`.
   */
  private canReuseExistingConnection(
    baseUrl: string,
    token: string,
    conversationId: string
  ): boolean {
    const sameConfig =
      this.config?.baseUrl === baseUrl &&
      this.config?.token === token &&
      this.config?.conversationId === conversationId;

    if (!sameConfig || !this.core) {
      return false;
    }

    return (
      this.snapshot.state === 'connecting' ||
      this.snapshot.state === 'connected' ||
      this.snapshot.state === 'reconnecting'
    );
  }

  private async withTransientCore<T>(
    baseUrl: string,
    token: string,
    handler: (core: IMCore) => Promise<T>
  ): Promise<T> {
    const core = this.createCore(baseUrl.replace(/\/+$/, ''), token.trim());
    try {
      // Business APIs (listConversations / getConversationMembers etc.) include the
      // Authorization header. Invalid tokens cause 401/403 whose error messages contain the
      // status code, which callers can detect via /\b40[0-9]\b/.
      return await handler(core);
    } finally {
      core.destroy();
    }
  }

  async connect(config: StudioIMConnectParams): Promise<IMSnapshot> {
    const baseUrl = config.baseUrl.replace(/\/+$/, '');
    const token = config.token.trim();
    const conversationId = config.conversationId.trim();

    if (this.canReuseExistingConnection(baseUrl, token, conversationId)) {
      if (!this.pollTimer && this.snapshot.state !== 'connecting') {
        this.startPolling();
      }
      return this.getSnapshot();
    }

    this.disconnect();
    this.config = { baseUrl, token, conversationId };
    this.snapshot = {
      conversationId,
      state: 'connecting',
      lastSyncedAt: null,
      messages: [],
      typingUserIds: [],
    };
    this.emitState();

    this.core = this.createCore(baseUrl, token);
    this.wireEvents();

    try {
      // Initial getMessages doubles as a token probe (Authorization header; bad token => 401).
      const msgs = await this.core.api.getMessages(conversationId, { limit: MESSAGE_PAGE_SIZE });
      this.snapshot.messages = mergeMessages(this.snapshot.messages, msgs as StudioIMMessageDTO[]);
      this.snapshot.state = 'connected';
      this.snapshot.lastSyncedAt = Date.now();
      this.emitState();
      this.emitMessages();
      this.core.connect();
      this.startPolling();
    } catch (error) {
      // Initial connect failure should be disconnected (not reconnecting) so callers know.
      this.snapshot.state = 'disconnected';
      this.emitState();
      this.emitError('connect', error);
      const is4xx = error instanceof Error && /\b40[0-9]\b/.test(error.message);
      if (is4xx) {
        this._onDidDetectStaleConversation.fire(conversationId);
      } else {
        this.reconnect.schedule();
      }
      throw error; // Propagate to caller.
    }

    return this.getSnapshot();
  }

  async listConversations(
    params: StudioIMListConversationsParams
  ): Promise<StudioIMConversationDTO[]> {
    return this.withTransientCore(params.baseUrl, params.token, async (core) => {
      const conversations = await core.api.listConversations();
      return conversations.map((conversation) => this.toConversationDTO(conversation));
    });
  }

  async createConversation(
    params: StudioIMCreateConversationParams
  ): Promise<StudioIMConversationDTO> {
    return this.withTransientCore(params.baseUrl, params.token, async (core) => {
      const conversation = await core.api.createConversation(
        params.type,
        params.memberIds,
        params.title
      );
      const conversations = await core.api.listConversations();
      const withMeta = conversations.find((item) => item.id === conversation.id);
      if (withMeta) {
        return this.toConversationDTO(withMeta);
      }
      return {
        id: conversation.id,
        type: conversation.type,
        title: conversation.title,
        unread_count: 0,
        created_at: conversation.created_at,
        last_message: null,
      };
    });
  }

  async getConversationMembersForConfig(
    baseUrl: string,
    token: string,
    conversationId: string
  ): Promise<Array<{ user_id: string; username: string; display_name: string; role: string }>> {
    return this.withTransientCore(baseUrl, token, (core) =>
      core.api.getConversationMembers(conversationId)
    );
  }

  async listUsersForConfig(baseUrl: string, token: string): Promise<User[]> {
    return this.withTransientCore(baseUrl, token, async (core) => core.api.listUsers());
  }

  disconnect(): void {
    this.reconnect.cancel();
    this.clearDowngradeTimer();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.core?.destroy();
    this.core = null;
    this.typingEntries.clear();
    this.reconnect.reset();
    this.consecutivePollFailures = 0;
    this.snapshot = { ...this.snapshot, state: 'disconnected', typingUserIds: [] };
    this.emitState();
    this.emitTyping();
    this.reconnect.enable();
  }

  async sendMessage(params: StudioIMSendMessageParams): Promise<StudioIMMessageDTO> {
    if (!this.core) throw new Error('IM is not configured');

    const msg = await this.core.api.sendMessage({
      conversation_id: params.conversationId,
      content: params.content,
      content_type: params.contentType || 'text',
      quoted_message_id: params.quotedMessageId,
      file_url: params.fileUrl,
      file_name: params.fileName,
      file_size: params.fileSize,
      thumbnail_url: params.thumbnailUrl,
      metadata: params.metadata as MessageMetadata | undefined,
    });

    const message = msg as StudioIMMessageDTO;
    this.snapshot.messages = mergeMessages(this.snapshot.messages, [message]);
    this.snapshot.lastSyncedAt = Date.now();
    this.emitMessages();
    this.emitState();
    return message;
  }

  async uploadAttachment(
    params: StudioIMUploadAttachmentParams
  ): Promise<StudioIMUploadAttachmentResult> {
    if (!this.core) throw new Error('IM is not configured');
    const result = await this.core.api.uploadFile({
      name: params.name,
      mimeType: params.mimeType,
      data: params.data,
    });
    return result as StudioIMUploadAttachmentResult;
  }

  sendTyping(conversationId: string): void {
    this.core?.sendTyping(conversationId);
  }

  dispose(): void {
    this.disconnect();
    this.config = null;
    this._onDidChangeState.dispose();
    this._onDidChangeMessages.dispose();
    this._onDidChangeTyping.dispose();
    this._onDidError.dispose();
    this._onDidDetectStaleConversation.dispose();
  }

  private wireEvents(): void {
    if (!this.core) return;

    this.core.on('connection:change', (state) => {
      if (state === 'connected') {
        // WebSocket recovered: propagate immediately and cancel any pending downgrade.
        this.clearDowngradeTimer();
        this.snapshot.state = 'connected';
        this.emitState();
        this.reconnect.reset();
        this.consecutivePollFailures = 0;
        this.adjustPollInterval(POLL_INTERVAL_CONNECTED_MS);
      } else {
        // WebSocket dropped: delay propagation to absorb brief flaps.
        this.adjustPollInterval(POLL_INTERVAL_DISCONNECTED_MS);
        if (!this.wsDowngradeTimer) {
          this.wsDowngradeTimer = setTimeout(() => {
            this.wsDowngradeTimer = null;
            // Only downgrade if we are still not connected (polling may have recovered us).
            if (this.snapshot.state !== 'connected') return;
            this.snapshot.state = state;
            this.emitState();
          }, STATE_DOWNGRADE_DELAY_MS);
        }
      }
    });

    this.core.on('message:new', (msg) => {
      if (msg.conversation_id === this.config?.conversationId) {
        this.snapshot.messages = mergeMessages(this.snapshot.messages, [msg as StudioIMMessageDTO]);
        this.snapshot.lastSyncedAt = Date.now();
        this.emitMessages();
        this.emitState();
      }
    });

    this.core.on('message:update', (msg) => {
      if (msg.conversation_id === this.config?.conversationId) {
        const idx = this.snapshot.messages.findIndex((m) => m.id === msg.id);
        if (idx >= 0) {
          this.snapshot.messages[idx] = msg as StudioIMMessageDTO;
        } else {
          this.snapshot.messages = mergeMessages(this.snapshot.messages, [
            msg as StudioIMMessageDTO,
          ]);
        }
        this.snapshot.lastSyncedAt = Date.now();
        this.emitMessages();
      }
    });

    this.core.on('message:typing', (data) => {
      if (data.conversation_id === this.config?.conversationId) {
        this.typingEntries.set(data.user_id, { expiresAt: Date.now() + TYPING_TTL_MS });
        this.emitTyping();
      }
    });

    this.core.on('error', (err) => {
      this.emitError('ws', err);
    });
  }

  private toConversationDTO(conversation: ConversationWithMeta): StudioIMConversationDTO {
    return {
      id: conversation.id,
      type: conversation.type,
      title: conversation.title,
      unread_count: conversation.unread_count,
      created_at: conversation.created_at,
      last_message: conversation.last_message
        ? {
            id: conversation.last_message.id,
            content: conversation.last_message.content,
            sender_id: conversation.last_message.sender_id,
            created_at: conversation.last_message.created_at,
          }
        : null,
    };
  }

  private currentPollIntervalMs = POLL_INTERVAL_CONNECTED_MS;

  private startPolling(intervalMs = POLL_INTERVAL_CONNECTED_MS): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.currentPollIntervalMs = intervalMs;
    this.pollTimer = setInterval(() => {
      if (!this.core || !this.config) return;
      void this.core.api
        .getMessages(this.config.conversationId, { limit: MESSAGE_PAGE_SIZE })
        .then((msgs) => {
          this.consecutivePollFailures = 0;
          // Successful poll proves the server is reachable; cancel any pending downgrade.
          this.clearDowngradeTimer();
          const merged = mergeMessages(this.snapshot.messages, msgs as StudioIMMessageDTO[]);
          const changed = !messagesEqual(this.snapshot.messages, merged);
          this.snapshot.messages = merged;
          this.snapshot.lastSyncedAt = Date.now();
          let stateChanged = false;
          if (this.snapshot.state === 'reconnecting') {
            this.snapshot.state = 'connected';
            this.reconnect.reset();
            stateChanged = true;
          }
          // Only notify renderer when messages really changed to avoid idle re-renders.
          if (changed) this.emitMessages();
          if (changed || stateChanged) this.emitState();
        })
        .catch((error) => {
          this.consecutivePollFailures++;
          this.emitError('poll', error);
          if (this.consecutivePollFailures >= POLL_FAILURE_THRESHOLD && !this.reconnect.pending) {
            this.snapshot.state = 'reconnecting';
            this.emitState();
            this.reconnect.schedule();
          }
        });
      this.pruneTyping();
    }, intervalMs);
  }

  /** Tune polling cadence on WS state change: connected = low-frequency, disconnected = high. */
  private adjustPollInterval(intervalMs: number): void {
    if (!this.pollTimer || this.currentPollIntervalMs === intervalMs) return;
    this.startPolling(intervalMs);
  }

  private async performReconnect(): Promise<void> {
    if (!this.config) return;

    // ReconnectManager already caps attempts, but guard here too: once exhausted, force
    // disconnected so we do not sit forever in reconnecting.
    if (this.reconnect.exhausted) {
      this.snapshot.state = 'disconnected';
      this.emitState();
      this.emitError(
        'reconnect',
        new Error(
          `Maximum reconnect attempts reached (${MAX_RECONNECT_ATTEMPTS}); please reconnect manually`
        )
      );
      logger.error(
        `[StudioIMService] Maximum reconnect attempts reached (${MAX_RECONNECT_ATTEMPTS}), stopping reconnects`
      );
      return;
    }

    const { baseUrl, token, conversationId } = this.config;

    logger.info('[StudioIMService] Starting reconnect...');

    // Tear down the old connection without running the full disconnect flow.
    this.clearDowngradeTimer();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.core?.destroy();
    this.core = null;

    this.core = this.createCore(baseUrl, token);
    this.wireEvents();

    try {
      // Same as connect(): getMessages doubles as a token probe.
      const msgs = await this.core.api.getMessages(conversationId, { limit: MESSAGE_PAGE_SIZE });
      this.snapshot.messages = mergeMessages(this.snapshot.messages, msgs as StudioIMMessageDTO[]);
      this.snapshot.state = 'connected';
      this.snapshot.lastSyncedAt = Date.now();
      this.reconnect.reset();
      this.consecutivePollFailures = 0;
      this.emitState();
      this.emitMessages();
      this.core.connect();
      this.startPolling();
      logger.info('[StudioIMService] Reconnect succeeded');
    } catch (error) {
      const is4xx = error instanceof Error && /\b40[0-9]\b/.test(error.message);
      if (is4xx) {
        // 403/404 = stale conversation: stop retrying and let upper layers clean binding.
        logger.error('[StudioIMService] reconnect failed (4xx, stop retry):', error);
        this.snapshot.state = 'disconnected';
        this.emitState();
        this.emitError('reconnect', error);
        if (this.config?.conversationId) {
          this._onDidDetectStaleConversation.fire(this.config.conversationId);
        }
      } else {
        this.snapshot.state = 'reconnecting';
        this.emitState();
        this.emitError('reconnect', error);
        this.reconnect.schedule();
      }
    }
  }

  private clearDowngradeTimer(): void {
    if (this.wsDowngradeTimer) {
      clearTimeout(this.wsDowngradeTimer);
      this.wsDowngradeTimer = null;
    }
  }

  private pruneTyping(): void {
    const now = Date.now();
    let changed = false;
    for (const [userId, entry] of this.typingEntries.entries()) {
      if (entry.expiresAt <= now) {
        this.typingEntries.delete(userId);
        changed = true;
      }
    }
    if (changed) this.emitTyping();
  }

  private emitState(): void {
    this._onDidChangeState.fire({
      conversationId: this.snapshot.conversationId,
      state: this.snapshot.state,
      lastSyncedAt: this.snapshot.lastSyncedAt,
    });
  }

  private emitMessages(): void {
    this._onDidChangeMessages.fire({
      conversationId: this.snapshot.conversationId,
      messages: [...this.snapshot.messages],
      lastSyncedAt: this.snapshot.lastSyncedAt,
    });
  }

  private emitTyping(): void {
    this.snapshot.typingUserIds = Array.from(this.typingEntries.keys());
    this._onDidChangeTyping.fire({
      conversationId: this.snapshot.conversationId,
      userIds: [...this.snapshot.typingUserIds],
    });
  }

  private emitError(scope: IMErrorDTO['scope'], error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[StudioIMService] ${scope} failed: ${message}`);
    this._onDidError.fire({ scope, message });
  }
}
