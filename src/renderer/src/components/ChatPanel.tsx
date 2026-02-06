/**
 * @file ChatPanel.tsx - AI Chat Panel
 * @description RAG-enhanced intelligent Q&A panel with multi-session and knowledge base retrieval
 * @depends api, AIService, useChatService
 */

import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle,
  AlertTriangle,
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  Copy,
  Database,
  Edit3,
  File,
  History,
  Loader2,
  MessageSquare,
  Plus,
  Search,
  Sparkles,
  Trash2,
  User,
} from 'lucide-react';
import type React from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChatMessage, Citation } from '../../../../shared/types/chat';
import { api } from '../api';
import { useChatService, useClickOutside, useWindowEvent } from '../hooks';
import { AIService } from '../services/AIService';
import {
  type AskAIAboutErrorRequest,
  getAIService,
  getEditorService,
  getProjectService,
  getUIService,
  useCompletionKnowledgeBaseId,
  useEditorTabs,
  useKnowledgeBases,
  usePolishRequest,
  useSelectedKnowledgeBaseId,
  useSidebarTab,
} from '../services/core';
import { formatChatTime } from '../utils';
import { useTranslation } from '../locales';
import { ChatInput } from './chat';
import { MarkdownContent } from './chat';
import { IconButton, ListItemSkeleton } from './ui';

function buildErrorAnalysisPrompt(request: AskAIAboutErrorRequest): string {
  const lines: string[] = [];
  lines.push(
    `Please analyze the following ${request.compilerType} compilation error and provide a fix:`
  );
  lines.push('');
  lines.push('**Error:**');
  lines.push(request.errorMessage);
  if (request.errorContent) {
    lines.push('');
    lines.push('**Error Details:**');
    lines.push(request.errorContent);
  }
  if (request.file) {
    lines.push('');
    lines.push(`**File:** ${request.file}${request.line ? `:${request.line}` : ''}`);
  }
  if (request.sourceContext) {
    lines.push('');
    lines.push('**Source Context:**');
    lines.push(`\`\`\`${request.compilerType.toLowerCase()}`);
    lines.push(request.sourceContext);
    lines.push('```');
  }
  return lines.join('\n');
}

// ====== Citations Panel ======

/** Formats timestamp seconds to mm:ss or hh:mm:ss */
function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const CitationsPanel = memo<{ citations?: Citation[]; searchTime?: number }>(
  ({ citations, searchTime }) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const { t } = useTranslation();

    if (!citations || citations.length === 0) return null;

    return (
      <div className="mt-2 space-y-1">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-1.5 text-xs transition-colors cursor-pointer hover:opacity-80"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <BookOpen size={12} />
          <span>
            {citations.length} {t('chat.sources')}
          </span>
          {searchTime && (
            <span style={{ color: 'var(--color-text-disabled)' }}>
              · {t('chat.searchTook', { time: String(searchTime) })}
            </span>
          )}
          <ChevronDown
            size={12}
            className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          />
        </button>

        {isExpanded && (
          <div className="space-y-2">
            {citations.map((cite, idx) => (
              <div
                key={`cite-${cite.documentId}-${idx}`}
                className="p-2.5 rounded-lg text-xs"
                style={{
                  background: 'var(--color-bg-tertiary)',
                  border: '1px solid var(--color-border)',
                }}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span style={{ color: 'var(--color-accent)' }} className="font-medium">
                    [Ref {idx + 1}]
                  </span>
                  <span
                    className="px-1.5 py-0.5 rounded"
                    style={{
                      background: 'var(--color-accent-muted)',
                      color: 'var(--color-accent)',
                    }}
                  >
                    {t('chat.relevant', { score: (cite.score * 100).toFixed(0) })}
                  </span>
                </div>

                <p
                  className="line-clamp-3 mb-2 leading-relaxed"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  {cite.snippet}
                </p>

                <div
                  className="flex items-center gap-2 flex-wrap"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  <div className="flex items-center gap-1">
                    <File size={10} />
                    <span>{cite.documentName}</span>
                  </div>

                  {cite.page !== undefined && <span>· Page {cite.page}</span>}

                  {cite.section && <span>· {cite.section}</span>}

                  {cite.startTime !== undefined && (
                    <span>
                      · {formatTimestamp(cite.startTime)}
                      {cite.endTime !== undefined && ` - ${formatTimestamp(cite.endTime)}`}
                    </span>
                  )}

                  {cite.speaker && <span>· Speaker: {cite.speaker}</span>}

                  {cite.caption && <span className="italic">· {cite.caption}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
);

CitationsPanel.displayName = 'CitationsPanel';

// ====== Message Bubble ======

interface MessageBubbleProps {
  message: ChatMessage;
  isStreaming?: boolean;
  polishRequest?: {
    polishedText?: string | null;
  } | null;
  onApplyPolish?: () => void;
  onClearPolish?: () => void;
}

const MessageBubble = memo<MessageBubbleProps>(
  ({ message, isStreaming, polishRequest, onApplyPolish, onClearPolish }) => {
    const [copied, setCopied] = useState(false);
    const { t } = useTranslation();

    const handleCopy = useCallback(() => {
      navigator.clipboard.writeText(message.content || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, [message.content]);

    const roleInfo = useMemo(() => {
      switch (message.role) {
        case 'user':
          return {
            label: t('chat.you'),
            icon: User,
            iconColor: 'var(--color-accent)',
            bgColor: 'var(--color-accent-muted)',
          };
        case 'assistant':
          return {
            label: t('chat.assistant'),
            icon: Bot,
            iconColor: 'var(--color-success)',
            bgColor: 'var(--color-success-muted)',
          };
        case 'system':
          return {
            label: t('chat.system'),
            icon: AlertCircle,
            iconColor: 'var(--color-text-muted)',
            bgColor: 'var(--color-bg-tertiary)',
          };
        default:
          return {
            label: t('chat.message'),
            icon: Bot,
            iconColor: 'var(--color-text-muted)',
            bgColor: 'var(--color-bg-tertiary)',
          };
      }
    }, [message.role, t]);

    const Icon = roleInfo.icon;

    return (
      <div className="group px-4 py-2 flex flex-col gap-1 hover:bg-[var(--color-bg-hover)] transition-colors">
        <div className="flex items-center gap-2 min-w-0">
          <div
            className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center"
            style={{
              background: roleInfo.bgColor,
              border: '1px solid var(--color-border)',
            }}
          >
            <Icon size={14} style={{ color: roleInfo.iconColor }} />
          </div>
          <span className="text-xs font-medium" style={{ color: roleInfo.iconColor }}>
            {roleInfo.label}
          </span>
          <span className="text-[10px]" style={{ color: 'var(--color-text-disabled)' }}>
            {new Date(message.timestamp).toLocaleTimeString('en-US', {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
          <button
            onClick={handleCopy}
            className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded cursor-pointer hover:bg-[var(--color-bg-tertiary)]"
            title={t('chat.copy')}
          >
            {copied ? (
              <Check size={12} style={{ color: 'var(--color-success)' }} />
            ) : (
              <Copy size={12} style={{ color: 'var(--color-text-muted)' }} />
            )}
          </button>
        </div>

        <div className="text-sm leading-relaxed" style={{ color: 'var(--color-text-primary)' }}>
          {message.content ? (
            isStreaming ? (
              // Why: Plain text during streaming to avoid Markdown/KaTeX re-parsing
              <span className="whitespace-pre-wrap">
                {message.content}
                <span className="inline-block w-2 h-4 ml-0.5 bg-[var(--color-accent)] animate-pulse rounded-sm align-middle" />
              </span>
            ) : (
              <MarkdownContent content={message.content} />
            )
          ) : message.role === 'assistant' ? (
            <span
              className="inline-flex items-center gap-1"
              style={{ color: 'var(--color-text-muted)' }}
            >
              <span className="w-2 h-4 bg-[var(--color-accent)] animate-pulse rounded-sm" />
            </span>
          ) : (
            <span style={{ color: 'var(--color-text-disabled)' }}>(empty)</span>
          )}
        </div>

        {/* Polish Result Actions */}
        {message.role === 'assistant' &&
          polishRequest?.polishedText &&
          message.content.includes(t('chat.polishResult')) && (
            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={onApplyPolish}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-all cursor-pointer"
                style={{
                  background: 'var(--color-success)',
                  color: 'white',
                }}
              >
                <Check size={12} />
                <span>{t('chat.applyToEditor')}</span>
              </button>
              <button
                onClick={onClearPolish}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-colors cursor-pointer"
                style={{
                  background: 'var(--color-bg-tertiary)',
                  color: 'var(--color-text-secondary)',
                }}
              >
                <span>{t('common.cancel')}</span>
              </button>
            </div>
          )}

        <CitationsPanel citations={message.citations} searchTime={message.searchTime} />
      </div>
    );
  }
);

MessageBubble.displayName = 'MessageBubble';

// ====== Main Component ======

export const ChatPanel: React.FC = () => {
  const sidebarTab = useSidebarTab();
  const isVisible = sidebarTab === 'ai';
  const projectService = getProjectService();
  const aiService = getAIService();
  const editorService = getEditorService();

  const {
    sessions,
    currentSession,
    messages,
    isGenerating,
    referencedFiles,
    referencedFailed,
    ragSearching,
    createSession,
    switchSession,
    deleteSession,
    renameSession,
    sendMessage,
    cancel,
    addLocalMessage,
    updateLocalMessage,
  } = useChatService();

  const knowledgeBases = useKnowledgeBases();
  const selectedKnowledgeBaseId = useSelectedKnowledgeBaseId();
  const completionKnowledgeBaseId = useCompletionKnowledgeBaseId();

  const polishRequest = usePolishRequest();
  const openTabs = useEditorTabs();
  const { t } = useTranslation();

  const [input, setInput] = useState('');
  const [showSessionList, setShowSessionList] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [showLibrarySelector, setShowLibrarySelector] = useState(false);
  const [shouldAutoFocus, setShouldAutoFocus] = useState(false);
  const [sessionListPosition, setSessionListPosition] = useState<{
    top: number;
    right: number;
  } | null>(null);

  const sessionListRef = useRef<HTMLDivElement>(null);
  const sessionButtonRef = useRef<HTMLButtonElement>(null);
  const selectorRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // ====== Effects ======

  useEffect(() => {
    if (!showSessionList || !sessionButtonRef.current) return;

    const updatePosition = () => {
      const rect = sessionButtonRef.current?.getBoundingClientRect();
      if (!rect) return;
      setSessionListPosition({
        top: rect.bottom + 8,
        right: window.innerWidth - rect.right,
      });
    };

    updatePosition();

    window.addEventListener('resize', updatePosition);
    return () => window.removeEventListener('resize', updatePosition);
  }, [showSessionList]);

  useClickOutside(sessionListRef, () => setShowSessionList(false), showSessionList);
  useClickOutside(selectorRef, () => setShowLibrarySelector(false), showLibrarySelector);

  useEffect(() => {
    if (sessions.length === 0) {
      void createSession();
    }
  }, [sessions.length, createSession]);

  useEffect(() => {
    if (!isVisible) return;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isGenerating, isVisible]);

  useEffect(() => {
    const uiService = getUIService();
    const disposable = uiService.onDidRequestAIErrorAnalysis((request: AskAIAboutErrorRequest) => {
      setInput(buildErrorAnalysisPrompt(request));
      setShouldAutoFocus(true);
      setTimeout(() => setShouldAutoFocus(false), 300);
    });
    return () => disposable.dispose();
  }, []);

  useEffect(() => {
    if (knowledgeBases.length > 0) return;
    if (!api.knowledge?.getLibraries) return;
    api.knowledge
      .getLibraries()
      .then((libs) => projectService.setKnowledgeBases(libs))
      .catch((error) => {
        console.error('[ChatPanel] Failed to load knowledge bases:', error);
      });
  }, [knowledgeBases.length, projectService]);

  const selectedLibrary = useMemo(
    () => knowledgeBases.find((kb) => kb.id === selectedKnowledgeBaseId) ?? null,
    [knowledgeBases, selectedKnowledgeBaseId]
  );

  // ====== Handlers ======

  const handleSend = useCallback(async () => {
    if (!input.trim() || isGenerating) return;
    await sendMessage(input.trim(), {
      knowledgeBaseId: selectedKnowledgeBaseId || undefined,
    });
    setInput('');
  }, [input, isGenerating, sendMessage, selectedKnowledgeBaseId]);

  const handleStop = useCallback(async () => {
    await cancel();
  }, [cancel]);

  const handleRenameSession = useCallback(
    (sessionId: string) => {
      if (editingTitle.trim()) {
        void renameSession(sessionId, editingTitle.trim());
      }
      setEditingSessionId(null);
      setEditingTitle('');
    },
    [editingTitle, renameSession]
  );

  useWindowEvent('keydown', (e) => {
    if (!isVisible) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      void handleSend();
    }
  });

  useWindowEvent('focus', () => {
    if (isVisible && !showLibrarySelector && !showSessionList) {
      setTimeout(() => {
        const activeEl = document.activeElement;
        const isModalActive = activeEl?.closest('.modal, [role="dialog"]');
        if (!isModalActive) {
          setShouldAutoFocus(true);
          setTimeout(() => setShouldAutoFocus(false), 100);
        }
      }, 50);
    }
  });

  // ====== Polish Feature ======

  const handlePolishAsChat = useCallback(async () => {
    if (!polishRequest) return;

    if (!currentSession) {
      await createSession();
    }

    addLocalMessage({
      role: 'user',
      content: `Please polish the following text, maintaining the original meaning while making it more fluent and professional:\n\n${polishRequest.originalText}`,
    });

    aiService.setPolishRequest({
      ...polishRequest,
      isPolishing: true,
    });

    const assistantMessage = addLocalMessage({
      role: 'assistant',
      content: '',
    });

    try {
      const polished = await AIService.polishText(
        polishRequest.originalText,
        completionKnowledgeBaseId || undefined
      );

      const kbInfo = completionKnowledgeBaseId ? '\n\n📚 *Knowledge base enhanced polishing*' : '';
      const polishLabel = t('chat.polishResult');
      const resultContent = `**${polishLabel}：**\n\n${polished}${kbInfo}\n\n---\n*Click button below to apply polished result to editor*`;

      if (assistantMessage) {
        updateLocalMessage(assistantMessage.id, { content: resultContent });
      }

      aiService.updatePolishResult(polished);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      if (assistantMessage) {
        updateLocalMessage(assistantMessage.id, { content: `❌ Polish failed: ${errorMsg}` });
      }
      aiService.updatePolishResult(`❌ Polish failed: ${errorMsg}`);
    }
  }, [
    polishRequest,
    currentSession,
    createSession,
    addLocalMessage,
    updateLocalMessage,
    aiService,
    completionKnowledgeBaseId,
    t,
  ]);

  useEffect(() => {
    if (polishRequest && !polishRequest.polishedText && !polishRequest.isPolishing) {
      void handlePolishAsChat();
    }
  }, [polishRequest, handlePolishAsChat]);

  const handleApplyPolish = useCallback(() => {
    if (
      !polishRequest ||
      !polishRequest.polishedText ||
      !polishRequest.filePath ||
      !polishRequest.selectionRange
    ) {
      return;
    }

    const tab = openTabs.find((t) => t.path === polishRequest.filePath);
    if (!tab) return;

    const { startLine, startColumn, endLine, endColumn } = polishRequest.selectionRange;
    const lines = tab.content.split('\n');

    let result = '';
    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      if (lineNum < startLine) {
        result += `${lines[i]}\n`;
      } else if (lineNum === startLine && lineNum === endLine) {
        result +=
          lines[i].substring(0, startColumn - 1) +
          polishRequest.polishedText +
          lines[i].substring(endColumn - 1);
        if (i < lines.length - 1) result += '\n';
      } else if (lineNum === startLine) {
        result += lines[i].substring(0, startColumn - 1);
      } else if (lineNum === endLine) {
        result += polishRequest.polishedText + lines[i].substring(endColumn - 1);
        if (i < lines.length - 1) result += '\n';
      } else if (lineNum > startLine && lineNum < endLine) {
        // Skip middle lines
      } else {
        result += lines[i];
        if (i < lines.length - 1) result += '\n';
      }
    }

    // Why: replaceContent triggers forceUpdate ensuring Monaco Editor updates
    editorService.replaceContent(polishRequest.filePath, result);
    aiService.clearPolishRequest();
  }, [polishRequest, openTabs, editorService, aiService]);

  // ====== Render ======

  return (
    <div
      className="flex flex-col h-full min-h-0 overflow-hidden"
      style={{
        background: 'var(--color-bg-primary)',
        overscrollBehavior: 'none',
        contain: 'strict',
      }}
      onWheel={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div
        className="px-4 py-3 flex items-center justify-between flex-shrink-0"
        style={{
          borderBottom: '1px solid var(--color-border)',
          background: 'var(--color-bg-secondary)',
        }}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{
              background: 'var(--color-accent-muted)',
              border: '1px solid var(--color-border)',
            }}
          >
            <MessageSquare size={16} style={{ color: 'var(--color-accent)' }} />
          </div>
          <div className="min-w-0">
            <div
              className="text-sm font-medium truncate"
              style={{ color: 'var(--color-text-primary)' }}
            >
              {currentSession?.title || t('chat.newChat')}
            </div>
            <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {currentSession
                ? formatChatTime(currentSession.updatedAt)
                : t('chat.startConversation')}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <IconButton onClick={() => createSession()} tooltip={t('chat.newChatTooltip')} size="sm">
            <Plus size={14} />
          </IconButton>
          <button
            ref={sessionButtonRef}
            onClick={() => setShowSessionList(!showSessionList)}
            className="p-1.5 rounded-lg transition-colors cursor-pointer"
            style={{
              background: showSessionList ? 'var(--color-accent-muted)' : 'transparent',
              color: showSessionList ? 'var(--color-accent)' : 'var(--color-text-secondary)',
            }}
            title={t('chat.history')}
          >
            <History size={14} />
          </button>
        </div>
      </div>

      {/* Session List Dropdown (Portal) */}
      {showSessionList &&
        sessionListPosition &&
        createPortal(
          <AnimatePresence>
            <motion.div
              ref={sessionListRef}
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="fixed w-80 max-h-96 overflow-y-auto rounded-xl z-[9999]"
              style={{
                top: sessionListPosition.top,
                right: sessionListPosition.right,
                background: 'var(--color-bg-elevated)',
                border: '1px solid var(--color-border)',
                boxShadow: 'var(--shadow-lg)',
              }}
              onWheel={(e) => e.stopPropagation()}
            >
              <div
                className="p-3 text-xs font-medium sticky top-0"
                style={{
                  color: 'var(--color-text-muted)',
                  borderBottom: '1px solid var(--color-border-subtle)',
                  background: 'var(--color-bg-elevated)',
                }}
              >
                {t('chat.chatHistory')}
              </div>
              {sessions.length === 0 ? (
                <div
                  className="px-4 py-6 text-center text-xs"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  {t('chat.noPreviousSessions')}
                </div>
              ) : (
                sessions.map((session) => (
                  <div
                    key={session.id}
                    className="px-3 py-2 flex items-center justify-between gap-2 cursor-pointer transition-colors hover:bg-[var(--color-bg-hover)]"
                    style={{
                      background:
                        session.id === currentSession?.id
                          ? 'var(--color-accent-muted)'
                          : 'transparent',
                    }}
                  >
                    {editingSessionId === session.id ? (
                      <input
                        value={editingTitle}
                        onChange={(e) => setEditingTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleRenameSession(session.id);
                          if (e.key === 'Escape') setEditingSessionId(null);
                        }}
                        autoFocus
                        className="flex-1 text-sm bg-transparent outline-none px-2 py-1 rounded"
                        style={{
                          color: 'var(--color-text-primary)',
                          background: 'var(--color-bg-tertiary)',
                          border: '1px solid var(--color-accent)',
                        }}
                      />
                    ) : (
                      <button
                        onClick={() => {
                          switchSession(session.id);
                          setShowSessionList(false);
                        }}
                        className="flex-1 text-left min-w-0 cursor-pointer"
                      >
                        <div
                          className="text-sm truncate"
                          style={{ color: 'var(--color-text-primary)' }}
                        >
                          {session.title}
                        </div>
                        <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                          {t('chat.messagesCount', { count: String(session.messageCount) })} ·{' '}
                          {formatChatTime(session.updatedAt)}
                        </div>
                      </button>
                    )}
                    <div className="flex items-center gap-0.5 flex-shrink-0">
                      <IconButton
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingSessionId(session.id);
                          setEditingTitle(session.title);
                        }}
                        size="sm"
                        tooltip={t('chat.rename')}
                      >
                        <Edit3 size={12} />
                      </IconButton>
                      <IconButton
                        onClick={async (e) => {
                          e.stopPropagation();
                          const confirmed = await api.dialog.confirm(
                            `Delete session "${session.title}"?`,
                            'Confirm'
                          );
                          if (confirmed) {
                            await deleteSession(session.id);
                          }
                        }}
                        size="sm"
                        variant="destructive"
                        tooltip={t('chat.delete')}
                      >
                        <Trash2 size={12} />
                      </IconButton>
                    </div>
                  </div>
                ))
              )}
            </motion.div>
          </AnimatePresence>,
          document.body
        )}

      {/* Knowledge Base Selector */}
      <div
        className="px-4 py-2 flex items-center justify-between flex-shrink-0"
        style={{
          borderBottom: '1px solid var(--color-border-subtle)',
          background: 'var(--color-bg-secondary)',
        }}
      >
        <div className="relative flex-1" ref={selectorRef}>
          <button
            onClick={() => setShowLibrarySelector(!showLibrarySelector)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-all cursor-pointer"
            style={{
              background: 'var(--color-bg-tertiary)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-text-secondary)',
            }}
          >
            <Database
              size={14}
              style={{
                color: selectedLibrary ? 'var(--color-info)' : 'var(--color-text-muted)',
              }}
            />
            <span style={{ color: 'var(--color-text-primary)' }}>
              {selectedLibrary ? selectedLibrary.name : t('chat.noKnowledgeBase')}
            </span>
            <ChevronDown
              size={12}
              className={`transition-transform ${showLibrarySelector ? 'rotate-180' : ''}`}
            />
          </button>

          <AnimatePresence>
            {showLibrarySelector && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                className="absolute top-full mt-1 left-0 w-64 rounded-xl z-50 max-h-60 overflow-y-auto"
                style={{
                  background: 'var(--color-bg-elevated)',
                  border: '1px solid var(--color-border)',
                  boxShadow: 'var(--shadow-lg)',
                }}
              >
                <button
                  onClick={() => {
                    projectService.setSelectedKnowledgeBase(null);
                    setShowLibrarySelector(false);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-sm cursor-pointer transition-colors hover:bg-[var(--color-bg-hover)]"
                  style={{ color: 'var(--color-text-primary)' }}
                >
                  <Sparkles size={14} style={{ color: 'var(--color-accent)' }} />
                  {t('chat.chatOnlyNoRag')}
                </button>
                {knowledgeBases.length === 0 ? (
                  <ListItemSkeleton rows={3} withIcon />
                ) : (
                  knowledgeBases.map((kb) => (
                    <button
                      key={kb.id}
                      onClick={() => {
                        projectService.setSelectedKnowledgeBase(kb.id);
                        setShowLibrarySelector(false);
                      }}
                      className="w-full flex items-center justify-between px-3 py-2.5 text-sm cursor-pointer transition-colors hover:bg-[var(--color-bg-hover)]"
                      style={{
                        background:
                          selectedKnowledgeBaseId === kb.id
                            ? 'var(--color-accent-muted)'
                            : 'transparent',
                      }}
                    >
                      <div className="flex items-center gap-2">
                        <BookOpen
                          size={14}
                          style={{
                            color:
                              selectedKnowledgeBaseId === kb.id
                                ? 'var(--color-accent)'
                                : 'var(--color-text-muted)',
                          }}
                        />
                        <span style={{ color: 'var(--color-text-primary)' }}>{kb.name}</span>
                      </div>
                      <span style={{ color: 'var(--color-text-muted)' }}>{kb.documentCount}</span>
                    </button>
                  ))
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Messages Area */}
      <div
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
        data-chat-scroll="true"
        style={{
          contain: 'layout style',
          overscrollBehavior: 'contain',
        }}
      >
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-8">
            <div
              className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
              style={{
                background: 'var(--color-accent-muted)',
                border: '1px solid var(--color-border)',
              }}
            >
              <MessageSquare size={32} style={{ color: 'var(--color-accent)' }} />
            </div>
            <h3 className="text-lg font-medium mb-2" style={{ color: 'var(--color-text-primary)' }}>
              {t('chat.askQuestion')}
            </h3>
            <p className="text-sm max-w-xs" style={{ color: 'var(--color-text-secondary)' }}>
              {t('chat.askQuestionDesc')}
            </p>
          </div>
        ) : (
          <>
            {messages.map((message, index) => (
              <MessageBubble
                key={message.id}
                message={message}
                isStreaming={
                  isGenerating && index === messages.length - 1 && message.role === 'assistant'
                }
                polishRequest={polishRequest}
                onApplyPolish={handleApplyPolish}
                onClearPolish={() => aiService.clearPolishRequest()}
              />
            ))}

            {isGenerating && (
              <div className="px-4 py-2 space-y-2">
                {ragSearching && (
                  <div
                    className="flex items-center gap-2 text-xs py-1.5 px-3 rounded-lg"
                    style={{
                      background: 'var(--color-info-muted)',
                      color: 'var(--color-info)',
                    }}
                  >
                    <Search size={12} className="animate-pulse" />
                    {t('chat.searchingKnowledgeBase')}
                  </div>
                )}

                {!ragSearching && (
                  <div
                    className="flex items-center gap-2 text-xs"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    <Loader2 size={14} className="animate-spin" />
                    {t('chat.generatingResponse')}
                  </div>
                )}
              </div>
            )}

            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Input Area */}
      <ChatInput
        value={input}
        onChange={setInput}
        onSend={handleSend}
        onStop={handleStop}
        isLoading={isGenerating}
        isDisabled={false}
        placeholder={t('chat.inputPlaceholder')}
        selectedLibraryName={selectedLibrary?.name}
        selectedLibraryDocCount={selectedLibrary?.documentCount}
        autoFocus={shouldAutoFocus || isVisible}
      />

      {/* @ Reference Status */}
      {(referencedFiles.length > 0 || referencedFailed.length > 0) && (
        <div className="px-4 py-2 flex-shrink-0 text-xs space-y-2">
          {referencedFiles.length > 0 && (
            <div
              className="py-1.5 px-3 rounded-lg"
              style={{
                background: 'var(--color-success-muted)',
                color: 'var(--color-success)',
              }}
            >
              <div className="flex items-center gap-2 mb-1">
                <File size={12} />
                <span>{t('chat.referencedFiles', { count: String(referencedFiles.length) })}</span>
              </div>
              <div className="ml-4 text-[10px] opacity-80 break-words">
                {referencedFiles.map((f) => f.path).join(', ')}
              </div>
            </div>
          )}

          {referencedFailed.length > 0 && (
            <div
              className="py-1.5 px-3 rounded-lg"
              style={{
                background: 'var(--color-warning-muted)',
                color: 'var(--color-warning)',
              }}
            >
              <div className="flex items-center gap-2 mb-1">
                <AlertTriangle size={12} />
                <span>
                  {t('chat.failedToReference', { count: String(referencedFailed.length) })}
                </span>
              </div>
              <div className="ml-4 text-[10px] opacity-80 break-words">
                {referencedFailed.map((f) => `${f.path}: ${f.reason}`).join('; ')}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ChatPanel;
