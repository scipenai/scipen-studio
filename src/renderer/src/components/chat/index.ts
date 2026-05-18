/**
 * @file index.ts - Chat Components Export
 * @description Unified export entry for chat-related components
 */
export { ChatInput } from './ChatInput';
export type { ChatInputProps } from './ChatInput';

export { MarkdownContent, processLatexBrackets } from './MarkdownContent';
export type { MarkdownContentProps } from './MarkdownContent';

// Agent (SNACA) chat surface — distinct from the legacy `ChatInput`-based
// chat which uses the older direct AI service.
export { ChatSidebar } from './ChatSidebar';
export { ChatMessage as AgentChatMessage } from './ChatMessage';
export { ThinkingRenderer } from './ThinkingRenderer';
export { AgentChatInput } from './AgentChatInput';
