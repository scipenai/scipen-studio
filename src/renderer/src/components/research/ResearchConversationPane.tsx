import type React from 'react';
import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import type { StudioIMMessageDTO } from '../../../../../shared/api-types';
import type { ArtifactSummary, ChatMessage } from '../../../../../shared/types/chat';
import { useTranslation } from '../../locales';
import { useLatestPendingReviewSource } from '../../services/core/hooks';
import { ChatInput } from '../chat';
import type { ChatInputContextBadge } from '../chat/ChatInput';
import {
  AssistantTaskCard,
  EmptyState,
  OpenClawConfigNotice,
  UserMessageBubble,
} from './AssistantTaskCard';
import { IMTaskCard } from './IMTaskCard';
import { humanizeAgentError, isBotMessage } from './conversationHelpers';

// ====== Virtuoso static components (module-level constants, avoid rebuilding per render) ======

const VIRTUOSO_COMPONENTS = {
  Header: () => <div className="pt-8" />,
  Item: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) => (
    <div {...props} className="mx-auto w-full max-w-[820px] px-6">
      {children}
    </div>
  ),
};

// ====== Message list (isolated memo; does not depend on inputValue so keystrokes don't re-render) ======

interface MessageListProps {
  isOpenClawRuntime: boolean;
  hasIMConfig: boolean;
  conversationScopeError: string | null;
  isOpenClawReady: boolean;
  builtinMessages: ChatMessage[];
  imMessages: StudioIMMessageDTO[];
  imLoading: boolean;
  isGenerating: boolean;
  chatError: string | null;
  onRetryConnection: () => void;
  onOpenSettings: () => void;
  onOpenArtifact: (artifact: ArtifactSummary) => void;
  onCompileArtifact: (artifact: ArtifactSummary) => void;
  onOpenIMFile: (filePath: string) => void;
  onCompileIMFile: (filePath: string) => void;
  onAcceptAutoFix: () => void;
  autoFixLabel?: string;
  botUserId?: string;
}

const MessageList: React.FC<MessageListProps> = memo(
  ({
    isOpenClawRuntime,
    hasIMConfig,
    conversationScopeError,
    isOpenClawReady,
    builtinMessages,
    imMessages,
    imLoading,
    isGenerating,
    chatError,
    onRetryConnection,
    onOpenSettings,
    onOpenArtifact,
    onCompileArtifact,
    onOpenIMFile,
    onCompileIMFile,
    onAcceptAutoFix,
    autoFixLabel,
    botUserId,
  }) => {
    const { t } = useTranslation();
    const virtuosoRef = useRef<VirtuosoHandle>(null);
    const latestPendingReviewSource = useLatestPendingReviewSource();
    const friendlyAgentError = useMemo(
      () => humanizeAgentError(conversationScopeError || chatError),
      [chatError, conversationScopeError]
    );
    const expandedIMMessageIds = useMemo(() => {
      const ids = new Set<string>();
      for (let index = imMessages.length - 1; index >= 0; index -= 1) {
        const message = imMessages[index];
        if (!isBotMessage(message, botUserId)) continue;
        ids.add(message.id);
        if (ids.size >= 2) break;
      }
      return ids;
    }, [imMessages, botUserId]);

    const showBuiltinEmpty = !isOpenClawRuntime && builtinMessages.length === 0;
    const showIMEmpty = isOpenClawRuntime && !isOpenClawReady;

    const renderIMMessage = useCallback(
      (index: number) => {
        const message = imMessages[index];
        const showPendingReviewBanner = Boolean(
          message.id === latestPendingReviewSource?.messageId &&
            (!message.metadata?.proposals || message.metadata.proposals.length === 0)
        );
        return (
          <div className="pb-5">
            <IMTaskCard
              message={message}
              botUserId={botUserId}
              onOpenFile={onOpenIMFile}
              onCompileFile={onCompileIMFile}
              onAcceptAutoFix={onAcceptAutoFix}
              autoFixLabel={autoFixLabel}
              showPendingReviewBanner={showPendingReviewBanner}
              isHistorical={!expandedIMMessageIds.has(message.id)}
            />
          </div>
        );
      },
      [
        imMessages,
        botUserId,
        onOpenIMFile,
        onCompileIMFile,
        onAcceptAutoFix,
        autoFixLabel,
        latestPendingReviewSource,
        expandedIMMessageIds,
      ]
    );

    const renderBuiltinMessage = useCallback(
      (index: number) => {
        const message = builtinMessages[index];
        return (
          <div className="pb-5">
            {message.role === 'user' ? (
              <UserMessageBubble message={message} />
            ) : (
              <AssistantTaskCard
                message={message}
                pending={isGenerating && index === builtinMessages.length - 1}
                onOpenArtifact={onOpenArtifact}
                onCompileArtifact={onCompileArtifact}
                onAcceptAutoFix={onAcceptAutoFix}
                autoFixLabel={autoFixLabel}
              />
            )}
          </div>
        );
      },
      [
        builtinMessages,
        isGenerating,
        onOpenArtifact,
        onCompileArtifact,
        onAcceptAutoFix,
        autoFixLabel,
      ]
    );

    const messageCount = isOpenClawRuntime ? imMessages.length : builtinMessages.length;
    const renderMessage = isOpenClawRuntime ? renderIMMessage : renderBuiltinMessage;

    const initialScrollDoneRef = useRef(false);
    useEffect(() => {
      if (initialScrollDoneRef.current || messageCount === 0) return;
      const frame = requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({
          index: messageCount - 1,
          align: 'end',
          behavior: 'auto',
        });
        initialScrollDoneRef.current = true;
      });
      return () => cancelAnimationFrame(frame);
    }, [messageCount]);

    const footerContent = useCallback(
      () => (
        <>
          {isOpenClawRuntime && imLoading && imMessages.length === 0 && (
            <div
              className="rounded-[24px] border px-5 py-4 text-sm mb-5"
              style={{
                borderColor: 'color-mix(in srgb, var(--color-accent) 24%, transparent)',
                background:
                  'color-mix(in srgb, var(--color-info-muted) 72%, var(--color-bg-elevated) 28%)',
                color: 'var(--color-accent)',
              }}
            >
              {t('research.connectingOpenClaw')}
            </div>
          )}
          {conversationScopeError && !chatError && (
            <div className="rounded-[24px] border border-[var(--color-warning)]/20 bg-[var(--color-warning-muted)] px-5 py-4 text-sm text-[var(--color-warning)] mb-5">
              {conversationScopeError}
            </div>
          )}
          {chatError && (
            <div className="my-2 flex max-w-[85%] items-start gap-2 rounded-lg border border-red-100 bg-red-50 p-3 text-sm text-red-600 mb-5">
              <span className="mt-0.5">⚠️</span>
              <p>{chatError}</p>
            </div>
          )}
        </>
      ),
      [isOpenClawRuntime, imLoading, imMessages.length, conversationScopeError, chatError, t]
    );

    if (showIMEmpty) {
      return (
        <div className="h-full overflow-y-auto">
          <div className="mx-auto w-full max-w-[820px] px-6 py-8">
            <OpenClawConfigNotice
              title={!hasIMConfig ? t('research.imNotConfigured') : friendlyAgentError.title}
              description={
                !hasIMConfig ? t('research.imNotConfiguredDesc') : friendlyAgentError.description
              }
              onRetry={onRetryConnection}
              onOpenSettings={onOpenSettings}
            />
          </div>
        </div>
      );
    }

    if (showBuiltinEmpty) {
      return (
        <div className="h-full overflow-y-auto">
          <div className="mx-auto w-full max-w-[820px] px-6 py-8">
            <EmptyState />
          </div>
        </div>
      );
    }

    return (
      <Virtuoso
        ref={virtuosoRef}
        totalCount={messageCount}
        itemContent={renderMessage}
        initialTopMostItemIndex={messageCount > 0 ? messageCount - 1 : 0}
        followOutput="smooth"
        className="h-full"
        style={{ overflowX: 'hidden' }}
        components={{
          ...VIRTUOSO_COMPONENTS,
          Footer: footerContent,
        }}
      />
    );
  }
);

MessageList.displayName = 'MessageList';

// ====== Conversation pane (combines message list + input) ======

export interface ResearchConversationPaneProps {
  isOpenClawRuntime: boolean;
  openClawStatus: {
    tone: 'success' | 'warning' | 'info';
    text: string;
  };
  hasIMConfig: boolean;
  conversationScopeError: string | null;
  isOpenClawReady: boolean;
  builtinMessages: ChatMessage[];
  imMessages: StudioIMMessageDTO[];
  imLoading: boolean;
  isGenerating: boolean;
  chatError: string | null;
  inputValue: string;
  inputPlaceholder?: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onRetryConnection: () => void;
  onOpenSettings: () => void;
  onOpenArtifact: (artifact: ArtifactSummary) => void;
  onCompileArtifact: (artifact: ArtifactSummary) => void;
  onOpenIMFile: (filePath: string) => void;
  onCompileIMFile: (filePath: string) => void;
  onAcceptAutoFix: () => void;
  autoFixLabel?: string;
  botUserId?: string;
  activeTabPath?: string;
  draftContextBadges?: ChatInputContextBadge[];
  inputPulseKey?: number;
  onDismissDraftContextBadge?: (id: string) => void;
}

export const ResearchConversationPane: React.FC<ResearchConversationPaneProps> = memo(
  ({
    isOpenClawRuntime,
    hasIMConfig,
    conversationScopeError,
    isOpenClawReady,
    builtinMessages,
    imMessages,
    imLoading,
    isGenerating,
    chatError,
    inputValue,
    inputPlaceholder,
    onInputChange,
    onSend,
    onRetryConnection,
    onOpenSettings,
    onOpenArtifact,
    onCompileArtifact,
    onOpenIMFile,
    onCompileIMFile,
    onAcceptAutoFix,
    autoFixLabel,
    botUserId,
    draftContextBadges = [],
    inputPulseKey = 0,
    onDismissDraftContextBadge,
  }) => {
    const { t } = useTranslation();

    return (
      <div className="relative grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden bg-[var(--color-bg-primary)]">
        <div className="min-h-0 flex-1">
          <MessageList
            isOpenClawRuntime={isOpenClawRuntime}
            hasIMConfig={hasIMConfig}
            conversationScopeError={conversationScopeError}
            isOpenClawReady={isOpenClawReady}
            builtinMessages={builtinMessages}
            imMessages={imMessages}
            imLoading={imLoading}
            isGenerating={isGenerating}
            chatError={chatError}
            onRetryConnection={onRetryConnection}
            onOpenSettings={onOpenSettings}
            onOpenArtifact={onOpenArtifact}
            onCompileArtifact={onCompileArtifact}
            onOpenIMFile={onOpenIMFile}
            onCompileIMFile={onCompileIMFile}
            onAcceptAutoFix={onAcceptAutoFix}
            autoFixLabel={autoFixLabel}
            botUserId={botUserId}
          />
        </div>

        <div
          className="border-t px-6 py-4 backdrop-blur-md"
          style={{
            borderTopColor: 'var(--color-border-subtle)',
            background: 'color-mix(in srgb, var(--color-bg-elevated) 92%, transparent)',
          }}
        >
          <div className="w-full px-6">
            <ChatInput
              value={inputValue}
              onChange={onInputChange}
              onSend={onSend}
              isLoading={isGenerating}
              isDisabled={false}
              autoFocus
              variant="immersive"
              contextBadges={draftContextBadges}
              pulseKey={inputPulseKey}
              onRemoveContextBadge={onDismissDraftContextBadge}
              placeholder={
                inputPlaceholder ||
                t('chat.inputPlaceholder') ||
                t('research.defaultInputPlaceholder')
              }
            />
            <div className="mt-2 flex items-center justify-between px-1 text-[11px] text-[var(--color-text-muted)]">
              <span>{t('research.sendShortcut')}</span>
              <span>{t('research.atFileReference')}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }
);

ResearchConversationPane.displayName = 'ResearchConversationPane';
