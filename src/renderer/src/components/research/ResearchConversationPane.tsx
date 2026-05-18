import type React from 'react';
import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import type { ArtifactSummary, ChatMessage } from '../../../../../shared/types/chat';
import { useTranslation } from '../../locales';
import { ChatInput } from '../chat';
import type { ChatInputContextBadge } from '../chat/ChatInput';
import { AssistantTaskCard, EmptyState, UserMessageBubble } from './AssistantTaskCard';
import { humanizeAgentError } from './conversationHelpers';

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

// ====== Message list ======

interface MessageListProps {
  builtinMessages: ChatMessage[];
  isGenerating: boolean;
  chatError: string | null;
  onOpenArtifact: (artifact: ArtifactSummary) => void;
  onCompileArtifact: (artifact: ArtifactSummary) => void;
  onAcceptAutoFix: () => void;
  autoFixLabel?: string;
}

const MessageList: React.FC<MessageListProps> = memo(
  ({
    builtinMessages,
    isGenerating,
    chatError,
    onOpenArtifact,
    onCompileArtifact,
    onAcceptAutoFix,
    autoFixLabel,
  }) => {
    const virtuosoRef = useRef<VirtuosoHandle>(null);
    const friendlyAgentError = useMemo(() => humanizeAgentError(chatError), [chatError]);

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
      [builtinMessages, isGenerating, onOpenArtifact, onCompileArtifact, onAcceptAutoFix, autoFixLabel]
    );

    const messageCount = builtinMessages.length;

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
          {chatError && (
            <div className="my-2 flex max-w-[85%] items-start gap-2 rounded-lg border border-red-100 bg-red-50 p-3 text-sm text-red-600 mb-5">
              <span className="mt-0.5">⚠️</span>
              <p>{friendlyAgentError.description || chatError}</p>
            </div>
          )}
        </>
      ),
      [chatError, friendlyAgentError]
    );

    if (messageCount === 0) {
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
        itemContent={renderBuiltinMessage}
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
  builtinMessages: ChatMessage[];
  isGenerating: boolean;
  chatError: string | null;
  inputValue: string;
  inputPlaceholder?: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onOpenSettings: () => void;
  onOpenArtifact: (artifact: ArtifactSummary) => void;
  onCompileArtifact: (artifact: ArtifactSummary) => void;
  onAcceptAutoFix: () => void;
  autoFixLabel?: string;
  activeTabPath?: string;
  draftContextBadges?: ChatInputContextBadge[];
  inputPulseKey?: number;
  onDismissDraftContextBadge?: (id: string) => void;
}

export const ResearchConversationPane: React.FC<ResearchConversationPaneProps> = memo(
  ({
    builtinMessages,
    isGenerating,
    chatError,
    inputValue,
    inputPlaceholder,
    onInputChange,
    onSend,
    onOpenArtifact,
    onCompileArtifact,
    onAcceptAutoFix,
    autoFixLabel,
    draftContextBadges = [],
    inputPulseKey = 0,
    onDismissDraftContextBadge,
  }) => {
    const { t } = useTranslation();

    return (
      <div className="relative grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden bg-[var(--color-bg-primary)]">
        <div className="min-h-0 flex-1">
          <MessageList
            builtinMessages={builtinMessages}
            isGenerating={isGenerating}
            chatError={chatError}
            onOpenArtifact={onOpenArtifact}
            onCompileArtifact={onCompileArtifact}
            onAcceptAutoFix={onAcceptAutoFix}
            autoFixLabel={autoFixLabel}
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
