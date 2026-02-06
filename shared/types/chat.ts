/**
 * @file Unified Chat Types
 * @description Type definitions for the RAG-enabled chat system
 * @depends None (pure type definitions)
 */

// ====== Citation (RAG Feature) ======

export interface Citation {
  documentId: string;
  documentName: string;
  snippet: string;
  /** Relevance score (0-1) */
  score: number;

  // PDF-specific
  page?: number;
  section?: string;

  // Audio-specific
  startTime?: number;
  endTime?: number;
  speaker?: string;

  // Image-specific
  caption?: string;

  highlights?: Array<{ start: number; end: number }>;
}

// ====== Unified Message ======

export type ChatMessageRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: ChatMessageRole;
  content: string;
  timestamp: number;
  citations?: Citation[];
  /** RAG search time (ms) */
  searchTime?: number;
}

// ====== Session ======

export type ChatSessionStatus = 'idle' | 'running' | 'error' | 'completed';

export interface ChatSession {
  id: string;
  title: string;
  status: ChatSessionStatus;
  knowledgeBaseId?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

// ====== Send Message Options ======

export interface SendMessageOptions {
  knowledgeBaseId?: string;
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
  | { type: 'message_start'; messageId: string; role: ChatMessageRole }
  | { type: 'text_delta'; content: string }
  | { type: 'message_complete'; messageId: string }
  | { type: 'files_referenced'; files: ReferencedFile[]; failed: ReferencedFileFailed[] }
  | { type: 'rag_search_start' }
  | { type: 'rag_search_complete'; citations: Citation[]; searchTime?: number }
  | { type: 'done' }
  | { type: 'error'; error: { code: string; message: string } }
  | { type: 'cancelled' };

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
