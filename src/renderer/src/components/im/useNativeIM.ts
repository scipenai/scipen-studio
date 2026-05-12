import { useCallback, useEffect, useRef, useState } from 'react';
import type { IMSnapshot, StudioIMMessageDTO } from '../../../../../shared/api-types';
import { api } from '../../api';
import { formatAttachmentsBlock, resolveAtMentions } from '../../services/AtMentionResolver';
import { getProjectRuntimeContext } from '../../services/core';
import { buildIMCollaborationMetadata } from '../../utils/im-collaboration';

export type ContentType = 'text' | 'image' | 'file';
export type MessageWithQuote = StudioIMMessageDTO;

type SendMessageOptions = {
  contentType?: ContentType;
  quotedMessageId?: string;
  fileUrl?: string;
  fileName?: string;
  fileSize?: number;
  thumbnailUrl?: string;
};

type NativeIMConfig = {
  baseUrl: string;
  token: string;
  conversationId: string;
};

function emptySnapshot(conversationId: string): IMSnapshot {
  return {
    conversationId,
    state: 'disconnected',
    lastSyncedAt: null,
    messages: [],
    typingUserIds: [],
  };
}

export function useNativeIM(config: NativeIMConfig) {
  const { baseUrl, token, conversationId } = config;
  const [snapshot, setSnapshot] = useState<IMSnapshot>(() => emptySnapshot(conversationId));
  const [isLoading, setIsLoading] = useState(false);
  const activeConversationRef = useRef(conversationId);

  /**
   * Connection lifecycle:
   *   Valid config   -> connect() (internally atomic disconnect + reconnect, race-free)
   *   Invalid config -> disconnect()
   *   Cleanup does not disconnect — the next connect() handles the old connection.
   */
  useEffect(() => {
    activeConversationRef.current = conversationId;
    let disposed = false;

    if (!baseUrl || !token || !conversationId) {
      // Invalid config -> disconnect explicitly (inside the effect body, not cleanup).
      setSnapshot(emptySnapshot(conversationId));
      setIsLoading(false);
      api.im.disconnect().catch(() => {});
      return () => {
        disposed = true;
      };
    }

    setSnapshot(emptySnapshot(conversationId));
    setIsLoading(true);

    // connect() atomically disconnects the old connection then opens a new one in the main
    // process, so a manual disconnect here is unnecessary.
    void api.im
      .connect({ baseUrl, token, conversationId })
      .then((nextSnapshot) => {
        if (!disposed && nextSnapshot.conversationId === activeConversationRef.current) {
          setSnapshot(nextSnapshot);
        }
      })
      .catch((err) => {
        console.warn('[useNativeIM] IM connection failed:', err);
        if (!disposed) {
          setSnapshot((prev) => ({ ...prev, state: 'disconnected' }));
        }
      })
      .finally(() => {
        if (!disposed) {
          setIsLoading(false);
        }
      });

    const disposeState = api.im.onStateChanged((payload) => {
      if (payload.conversationId !== activeConversationRef.current) return;
      setSnapshot((current) => ({
        ...current,
        conversationId: payload.conversationId,
        state: payload.state,
        lastSyncedAt: payload.lastSyncedAt,
      }));
    });

    const disposeMessages = api.im.onMessagesChanged((payload) => {
      if (payload.conversationId !== activeConversationRef.current) return;
      setSnapshot((current) => ({
        ...current,
        conversationId: payload.conversationId,
        messages: payload.messages,
        lastSyncedAt: payload.lastSyncedAt,
      }));
    });

    const disposeTyping = api.im.onTypingChanged((payload) => {
      if (payload.conversationId !== activeConversationRef.current) return;
      setSnapshot((current) => ({
        ...current,
        conversationId: payload.conversationId,
        typingUserIds: payload.userIds,
      }));
    });

    return () => {
      disposed = true;
      disposeState();
      disposeMessages();
      disposeTyping();
      // Do not disconnect — the next effect's connect() or disconnect() will handle it.
    };
  }, [baseUrl, token, conversationId]);

  // Disconnect when the component unmounts.
  useEffect(() => {
    return () => {
      api.im.disconnect().catch(() => {});
    };
  }, []);

  // Trust the main process's snapshot.state directly for connection status.
  // The main process already has thorough health detection (WebSocket disconnect + polling
  // failure threshold + degradation delay). Adding a second staleness check in the renderer
  // would cause UI flicker: 30s polling interval vs. 6s staleness window.
  const isConnected = snapshot.state === 'connected';

  const sendMessage = useCallback(
    async (content: string, options?: SendMessageOptions) => {
      if (!conversationId || !content.trim()) return;
      // Bootstrap gate: reject sends while the project is not ready, to avoid metadata
      // carrying a stale/empty projectId.
      const rt = getProjectRuntimeContext();
      if (rt.bootstrapState === 'booting') {
        throw new Error('项目正在初始化，请稍候再发送消息');
      }

      // Resolve @path mentions to full file content and inline them as
      // <attachments><file>...</file></attachments> at the end of the message.
      // This pure-IM path means any bot/runtime sees the file content directly
      // in the message body — no plugin-side metadata consumer required.
      let outgoingContent = content.trim();
      try {
        const resolved = await resolveAtMentions(content, rt.rootPath);
        const cleaned = resolved.cleanedText.trim();
        const baseText = cleaned.length > 0 ? cleaned : outgoingContent;
        const attachmentsBlock = formatAttachmentsBlock(resolved.referencedFiles);
        outgoingContent = attachmentsBlock ? `${baseText}\n\n${attachmentsBlock}` : baseText;
      } catch {
        // Resolution failure is non-fatal; fall back to the original text.
        outgoingContent = content.trim();
      }

      let metadata: ReturnType<typeof buildIMCollaborationMetadata>;
      try {
        metadata = buildIMCollaborationMetadata(conversationId);
      } catch {
        // Allow sending the message even when the collaboration context is incomplete (no metadata).
        metadata = undefined;
      }
      await api.im.sendMessage({
        conversationId,
        content: outgoingContent,
        contentType: options?.contentType,
        quotedMessageId: options?.quotedMessageId,
        fileUrl: options?.fileUrl,
        fileName: options?.fileName,
        fileSize: options?.fileSize,
        thumbnailUrl: options?.thumbnailUrl,
        metadata,
      });
    },
    [conversationId]
  );

  return {
    snapshot,
    isLoading,
    isConnected,
    sendMessage,
  };
}
