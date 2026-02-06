/**
 * @file useChatService.ts - Unified chat service Hook
 * @description React state management for chat, including session management, message lists, streaming updates, tool confirmation, etc.
 * @depends ChatService
 */

import { useCallback, useSyncExternalStore } from 'react';
import type {
  ChatSession,
  ReferencedFile,
  ReferencedFileFailed,
  SendMessageOptions,
  ChatMessage as UnifiedChatMessage,
} from '../../../../shared/types/chat';
import { getChatService } from '../services/core/ChatService';

// ============ Types ============

export interface UseChatServiceReturn {
  // Session State
  sessions: ChatSession[];
  currentSessionId: string | null;
  currentSession: ChatSession | null;

  // Messages
  messages: UnifiedChatMessage[];

  // State
  isGenerating: boolean;

  // @ File Reference State
  referencedFiles: ReferencedFile[];
  referencedFailed: ReferencedFileFailed[];

  // RAG Search State
  ragSearching: boolean;

  // Session Actions
  createSession: (knowledgeBaseId?: string) => Promise<string>;
  switchSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => Promise<void>;
  renameSession: (sessionId: string, title: string) => Promise<void>;

  // Message Actions
  sendMessage: (content: string, options: SendMessageOptions) => Promise<void>;
  cancel: () => Promise<void>;
  addLocalMessage: (
    message: Omit<UnifiedChatMessage, 'id' | 'sessionId' | 'timestamp'>
  ) => UnifiedChatMessage | null;
  updateLocalMessage: (
    messageId: string,
    updates: Partial<UnifiedChatMessage>
  ) => UnifiedChatMessage | null;
}

// ====== Hook Implementation ======

/**
 * Unified chat service hook providing session management, messages, and streaming updates.
 *
 * @example
 * ```tsx
 * function ChatPanel() {
 *   const {
 *     messages,
 *     isGenerating,
 *     sendMessage,
 *     cancel,
 *   } = useChatService();
 *
 *   const handleSend = (text: string) => {
 *     sendMessage(text, {});
 *   };
 *
 *   return (
 *     <div>
 *       {messages.map(msg => <Message key={msg.id} message={msg} />)}
 *       {isGenerating && <LoadingIndicator />}
 *     </div>
 *   );
 * }
 * ```
 */
export function useChatService(): UseChatServiceReturn {
  const service = getChatService();

  // ============ Subscriptions using useSyncExternalStore ============

  // Sessions list
  const sessions = useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => {
        const d1 = service.onDidCreateSession(() => onStoreChange());
        const d2 = service.onDidDeleteSession(() => onStoreChange());
        const d3 = service.onDidRenameSession(() => onStoreChange());
        const d4 = service.onDidUpdateSession(() => onStoreChange());
        return () => {
          d1.dispose();
          d2.dispose();
          d3.dispose();
          d4.dispose();
        };
      },
      [service]
    ),
    () => service.sessions,
    () => service.sessions
  );

  // Current session ID
  const currentSessionId = useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => {
        const d = service.onDidSwitchSession(() => onStoreChange());
        return () => d.dispose();
      },
      [service]
    ),
    () => service.currentSessionId,
    () => service.currentSessionId
  );

  // Current session
  const currentSession = useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => {
        const d1 = service.onDidSwitchSession(() => onStoreChange());
        const d2 = service.onDidUpdateSession(() => onStoreChange());
        const d3 = service.onDidRenameSession(() => onStoreChange());
        return () => {
          d1.dispose();
          d2.dispose();
          d3.dispose();
        };
      },
      [service]
    ),
    () => service.currentSession,
    () => service.currentSession
  );

  // Messages
  const messages = useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => {
        const d1 = service.onDidAddMessage(() => onStoreChange());
        const d2 = service.onDidUpdateMessage(() => onStoreChange());
        const d3 = service.onDidCompleteMessage(() => onStoreChange());
        const d4 = service.onDidSwitchSession(() => onStoreChange());
        return () => {
          d1.dispose();
          d2.dispose();
          d3.dispose();
          d4.dispose();
        };
      },
      [service]
    ),
    () => service.getCurrentMessages(),
    () => service.getCurrentMessages()
  );

  // Loading state
  const isGenerating = useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => {
        const d = service.onDidChangeLoading(() => onStoreChange());
        return () => d.dispose();
      },
      [service]
    ),
    () => service.isGenerating,
    () => service.isGenerating
  );

  // @ File Reference state
  const referencedFiles = useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => {
        const d1 = service.onDidFilesReferenced(() => onStoreChange());
        const d2 = service.onDidChangeLoading(() => onStoreChange()); // Reset on new generation
        return () => {
          d1.dispose();
          d2.dispose();
        };
      },
      [service]
    ),
    () => service.referencedFiles,
    () => service.referencedFiles
  );

  const referencedFailed = useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => {
        const d1 = service.onDidFilesReferenced(() => onStoreChange());
        const d2 = service.onDidChangeLoading(() => onStoreChange());
        return () => {
          d1.dispose();
          d2.dispose();
        };
      },
      [service]
    ),
    () => service.referencedFailed,
    () => service.referencedFailed
  );

  // RAG search state
  const ragSearching = useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => {
        const d1 = service.onDidRagSearch(() => onStoreChange());
        const d2 = service.onDidChangeLoading(() => onStoreChange());
        return () => {
          d1.dispose();
          d2.dispose();
        };
      },
      [service]
    ),
    () => service.ragSearching,
    () => service.ragSearching
  );

  // ============ Actions ============

  const createSession = useCallback(
    async (knowledgeBaseId?: string) => {
      return service.createSession(knowledgeBaseId);
    },
    [service]
  );

  const switchSession = useCallback(
    (sessionId: string) => {
      service.switchSession(sessionId);
    },
    [service]
  );

  const deleteSession = useCallback(
    async (sessionId: string) => {
      await service.deleteSession(sessionId);
    },
    [service]
  );

  const renameSession = useCallback(
    async (sessionId: string, title: string) => {
      await service.renameSession(sessionId, title);
    },
    [service]
  );

  const sendMessage = useCallback(
    async (content: string, options: SendMessageOptions) => {
      await service.sendMessage(content, options);
    },
    [service]
  );

  const cancel = useCallback(async () => {
    await service.cancel();
  }, [service]);

  const addLocalMessage = useCallback(
    (message: Omit<UnifiedChatMessage, 'id' | 'sessionId' | 'timestamp'>) => {
      return service.addLocalMessage(message);
    },
    [service]
  );

  const updateLocalMessage = useCallback(
    (messageId: string, updates: Partial<UnifiedChatMessage>) => {
      return service.updateLocalMessage(messageId, updates);
    },
    [service]
  );

  return {
    // State
    sessions,
    currentSessionId,
    currentSession,
    messages,
    isGenerating,

    // @ File Reference State
    referencedFiles,
    referencedFailed,

    // RAG Search State
    ragSearching,

    // Session Actions
    createSession,
    switchSession,
    deleteSession,
    renameSession,

    // Message Actions
    sendMessage,
    cancel,
    addLocalMessage,
    updateLocalMessage,
  };
}

// ====== Individual Hooks (for optimized re-renders) ======

/**
 * Subscribes only to message list changes (avoids re-renders from other state).
 */
export function useChatMessages(): UnifiedChatMessage[] {
  const service = getChatService();

  return useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => {
        const d1 = service.onDidAddMessage(() => onStoreChange());
        const d2 = service.onDidUpdateMessage(() => onStoreChange());
        const d3 = service.onDidCompleteMessage(() => onStoreChange());
        const d4 = service.onDidSwitchSession(() => onStoreChange());
        return () => {
          d1.dispose();
          d2.dispose();
          d3.dispose();
          d4.dispose();
        };
      },
      [service]
    ),
    () => service.getCurrentMessages(),
    () => service.getCurrentMessages()
  );
}

/**
 * Subscribes only to session list changes.
 */
export function useChatSessions(): ChatSession[] {
  const service = getChatService();

  return useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => {
        const d1 = service.onDidCreateSession(() => onStoreChange());
        const d2 = service.onDidDeleteSession(() => onStoreChange());
        const d3 = service.onDidRenameSession(() => onStoreChange());
        return () => {
          d1.dispose();
          d2.dispose();
          d3.dispose();
        };
      },
      [service]
    ),
    () => service.sessions,
    () => service.sessions
  );
}

/**
 * Subscribes only to current session changes.
 */
export function useCurrentChatSession(): ChatSession | null {
  const service = getChatService();

  return useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => {
        const d1 = service.onDidSwitchSession(() => onStoreChange());
        const d2 = service.onDidUpdateSession(() => onStoreChange());
        const d3 = service.onDidRenameSession(() => onStoreChange());
        return () => {
          d1.dispose();
          d2.dispose();
          d3.dispose();
        };
      },
      [service]
    ),
    () => service.currentSession,
    () => service.currentSession
  );
}

/**
 * Subscribes only to generating state changes.
 */
export function useChatGenerating(): boolean {
  const service = getChatService();

  return useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => {
        const d = service.onDidChangeLoading(() => onStoreChange());
        return () => d.dispose();
      },
      [service]
    ),
    () => service.isGenerating,
    () => service.isGenerating
  );
}
