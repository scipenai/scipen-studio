/**
 * @file index.ts - Chat Components Export
 * @description Unified export entry for chat-related components. SNACA is
 *   the only chat runtime; the legacy builtin ChatInput is gone.
 */

export { MarkdownContent, processLatexBrackets } from './MarkdownContent';
export type { MarkdownContentProps } from './MarkdownContent';

// SNACA chat surface.
export { ChatSidebar } from './ChatSidebar';
export { ChatMessage as AgentChatMessage } from './ChatMessage';
export { ThinkingRenderer } from './ThinkingRenderer';
export { AgentChatInput } from './AgentChatInput';
