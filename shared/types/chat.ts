/**
 * @file Unified Chat Types
 * @description Type definitions for the chat system
 * @depends None (pure type definitions)
 */

export type ThinkingStepStatus = 'pending' | 'running' | 'completed' | 'error';

export interface ThinkingStep {
  id: string;
  label: string;
  status: ThinkingStepStatus;
}

export interface ArtifactSummary {
  id: string;
  path: string;
  title: string;
  kind: 'file';
  language?: string;
  summary?: string;
  charCount?: number;
  source?: 'openclaw' | 'builtin' | 'local';
}

export interface MarkdownChatBlock {
  type: 'markdown';
  content: string;
}

export interface ThinkingChatBlock {
  type: 'thinking';
  title: string;
  steps: ThinkingStep[];
  collapsed?: boolean;
}

export interface ArtifactChatBlock {
  type: 'artifact';
  artifact: ArtifactSummary;
}

export interface StatusChatBlock {
  type: 'status';
  status: 'info' | 'running' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
  attempt?: number;
  actionLabel?: string;
}

export type ChatMessageBlock =
  | MarkdownChatBlock
  | ThinkingChatBlock
  | ArtifactChatBlock
  | StatusChatBlock;

// ====== Unified Message ======

export type ChatMessageRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: ChatMessageRole;
  content: string;
  timestamp: number;
  blocks?: ChatMessageBlock[];
}

// ====== Session ======

export type ChatSessionStatus = 'idle' | 'running' | 'error' | 'completed';

export interface ChatSession {
  id: string;
  title: string;
  status: ChatSessionStatus;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

// ====== Send Message Options ======

export interface SendMessageOptions {
  workspace?: {
    projectPath?: string | null;
    activeFilePath?: string | null;
  };
}

// ====== Stream Events ======

export interface ReferencedFile {
  path: string;
  truncated: boolean;
  tokenEstimate: number;
}

export interface ReferencedFileFailed {
  path: string;
  reason: string;
}

export type ChatStreamEvent =
  | { type: 'session_created'; sessionId: string }
  | { type: 'session_updated'; session: ChatSession }
  | { type: 'message_start'; messageId: string; role: ChatMessageRole; sessionId?: string }
  | { type: 'text_delta'; content: string; sessionId?: string }
  | {
      type: 'thinking_update';
      title: string;
      steps: ThinkingStep[];
      collapsed?: boolean;
      sessionId?: string;
    }
  | {
      type: 'artifact_upsert';
      artifact: ArtifactSummary;
      sessionId?: string;
    }
  | {
      type: 'compile_update';
      status: StatusChatBlock['status'];
      title: string;
      message: string;
      attempt?: number;
      actionLabel?: string;
      sessionId?: string;
    }
  | {
      type: 'agent_state';
      status: 'running' | 'idle' | 'error';
      tool?: string;
      message: string;
      sessionId?: string;
    }
  | { type: 'message_complete'; messageId: string; sessionId?: string }
  | {
      type: 'files_referenced';
      files: ReferencedFile[];
      failed: ReferencedFileFailed[];
      sessionId?: string;
    }
  | { type: 'done'; sessionId?: string }
  | { type: 'error'; error: { code: string; message: string }; sessionId?: string }
  | { type: 'cancelled'; sessionId?: string };

// ====== IPC Request/Response Types ======

export interface ChatSendMessageParams {
  sessionId: string | null;
  content: string;
  options: SendMessageOptions;
}

export interface ChatSendMessageResult {
  sessionId: string;
  userMessageId: string;
}

export interface ChatOperationResult {
  success: boolean;
  error?: string;
}

export interface ChatSessionsResult {
  sessions: ChatSession[];
}

export interface ChatGetMessagesParams {
  sessionId: string;
  limit?: number;
  before?: number;
}

export interface ChatMessagesResult {
  sessionId: string;
  messages: ChatMessage[];
  hasMore: boolean;
}

export interface ChatRenameSessionParams {
  sessionId: string;
  title: string;
}
