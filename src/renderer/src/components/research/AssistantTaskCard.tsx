import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, Loader2, Orbit, Play, Sparkles, TriangleAlert } from 'lucide-react';
import { memo, useMemo } from 'react';
import type {
  ArtifactSummary,
  ChatMessage,
  ChatMessageBlock,
} from '../../../../../shared/types/chat';
import { t } from '../../locales';
import { MarkdownContent } from '../chat/MarkdownContent';
import { Button, Card } from '../ui';
import {
  DISPLAY_NAME_BOT,
  formatTimeLabel,
  getArtifactIcon,
  getArtifactSubtitle,
  getStatusStyles,
  hasVisibleMessageContent,
  shouldOfferAutoFix,
} from './conversationHelpers';

export const EmptyState = memo(function EmptyState() {
  return <div className="h-full min-h-[320px]" />;
});

export const UserMessageBubble = memo(function UserMessageBubble({
  message,
}: { message: ChatMessage }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="ml-auto w-full max-w-[540px]"
    >
      <div className="mb-1.5 flex items-center justify-end gap-2 pr-2 text-[10px] text-[var(--color-text-muted)]">
        <span>{formatTimeLabel(message.timestamp)}</span>
      </div>
      <div
        className="ml-auto rounded-[20px] px-4 py-3 text-[14px] leading-[1.75] shadow-[var(--shadow-sm)] ring-1 ring-inset"
        style={{
          background: 'var(--research-chat-user-bg)',
          color: 'var(--research-chat-body)',
          boxShadow: '0 14px 30px color-mix(in srgb, var(--color-accent) 14%, transparent)',
          borderColor: 'var(--research-chat-user-border)',
        }}
      >
        <div className="whitespace-pre-wrap">{message.content}</div>
      </div>
    </motion.div>
  );
});

const ArtifactCard = memo(function ArtifactCard({
  artifact,
  onOpen,
  onCompile,
}: {
  artifact: ArtifactSummary;
  onOpen?: (artifact: ArtifactSummary) => void;
  onCompile?: (artifact: ArtifactSummary) => void;
}) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
    >
      <Card
        variant="default"
        padding="md"
        className="rounded-[14px]"
        style={{
          borderColor: 'var(--color-border-subtle)',
          background: 'color-mix(in srgb, var(--color-bg-elevated) 96%, transparent)',
          boxShadow: 'var(--shadow-sm)',
        }}
      >
        <div className="flex items-center gap-3">
          <div
            className="flex h-10 w-10 items-center justify-center rounded-2xl ring-1 ring-inset"
            style={{
              background: 'color-mix(in srgb, var(--color-bg-primary) 82%, transparent)',
              borderColor: 'var(--color-border)',
            }}
          >
            {getArtifactIcon(artifact)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-[var(--color-text-primary)]">
              {artifact.title}
            </div>
            <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-muted)]">
              {getArtifactSubtitle(artifact.path, artifact.language)}
            </div>
            {artifact.summary && (
              <div className="mt-1 line-clamp-2 text-[12px] leading-5 text-[var(--color-text-secondary)]">
                {artifact.summary}
              </div>
            )}
          </div>
        </div>
        <div
          className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3"
          style={{ borderTopColor: 'var(--color-border-subtle)' }}
        >
          <Button
            size="sm"
            variant="secondary"
            className="rounded-full px-3.5"
            onClick={() => onOpen?.(artifact)}
          >
            {t('research.openFile')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            className="rounded-full px-3.5"
            onClick={() => onCompile?.(artifact)}
            leftIcon={<Play size={14} />}
          >
            {t('research.compilePreview')}
          </Button>
        </div>
      </Card>
    </motion.div>
  );
});

const ResearchMessageBlocks = memo(function ResearchMessageBlocks({
  blocks,
  content,
  onOpenArtifact,
  onCompileArtifact,
}: {
  blocks?: ChatMessageBlock[];
  content: string;
  onOpenArtifact?: (artifact: ArtifactSummary) => void;
  onCompileArtifact?: (artifact: ArtifactSummary) => void;
}) {
  const resolvedBlocks = useMemo<ChatMessageBlock[]>(() => {
    if (blocks && blocks.length > 0) {
      return blocks;
    }
    if (!content.trim()) {
      return [];
    }
    return [{ type: 'markdown', content }];
  }, [blocks, content]);

  return (
    <div className="space-y-3">
      <AnimatePresence initial={false}>
        {resolvedBlocks.map((block, index) => {
          if (block.type === 'markdown') {
            if (!block.content.trim()) return null;
            return (
              // eslint-disable-next-line react/no-array-index-key -- chat blocks are append-only stream output, index is stable
              <div key={`markdown-${index}`} className="text-sm text-[var(--color-text-secondary)]">
                <MarkdownContent
                  content={block.content}
                  className="chat-markdown [&_p]:leading-7 [&_code]:text-[0.92em]"
                />
              </div>
            );
          }

          if (block.type === 'thinking') {
            return (
              <motion.div
                // eslint-disable-next-line react/no-array-index-key -- chat blocks are append-only stream output, index is stable
                key={`thinking-${index}`}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
              >
                <details
                  className="rounded-[16px] border px-4 py-3"
                  style={{
                    borderColor: 'var(--color-border-subtle)',
                    background: 'color-mix(in srgb, var(--color-bg-elevated) 94%, transparent)',
                    boxShadow: 'var(--shadow-sm)',
                  }}
                >
                  <summary className="flex cursor-pointer list-none items-center gap-2 text-[13px] font-medium text-[var(--color-text-secondary)]">
                    <Sparkles className="h-4 w-4 text-sky-600" />
                    <span>{block.title}</span>
                  </summary>
                  <div className="mt-3 space-y-2">
                    {block.steps.map((step) => {
                      const tone =
                        step.status === 'completed'
                          ? 'text-[var(--color-success)]'
                          : step.status === 'running'
                            ? 'text-[var(--color-accent)]'
                            : step.status === 'error'
                              ? 'text-[var(--color-error)]'
                              : 'text-[var(--color-text-muted)]';
                      const stepStyle =
                        step.status === 'completed'
                          ? {
                              background:
                                'color-mix(in srgb, var(--color-success-muted) 72%, var(--color-bg-primary) 28%)',
                              borderColor:
                                'color-mix(in srgb, var(--color-success) 24%, transparent)',
                            }
                          : step.status === 'running'
                            ? {
                                background:
                                  'color-mix(in srgb, var(--color-info-muted) 72%, var(--color-bg-primary) 28%)',
                                borderColor:
                                  'color-mix(in srgb, var(--color-accent) 24%, transparent)',
                              }
                            : step.status === 'error'
                              ? {
                                  background:
                                    'color-mix(in srgb, var(--color-error-muted) 72%, var(--color-bg-primary) 28%)',
                                  borderColor:
                                    'color-mix(in srgb, var(--color-error) 24%, transparent)',
                                }
                              : {
                                  background:
                                    'color-mix(in srgb, var(--color-bg-hover) 78%, var(--color-bg-primary) 22%)',
                                  borderColor: 'var(--color-border-subtle)',
                                };
                      return (
                        <div
                          key={step.id}
                          className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 text-sm ${tone}`}
                          style={stepStyle}
                        >
                          {step.status === 'running' ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : step.status === 'completed' ? (
                            <CheckCircle2 className="h-4 w-4" />
                          ) : step.status === 'error' ? (
                            <TriangleAlert className="h-4 w-4" />
                          ) : (
                            <div className="h-2.5 w-2.5 rounded-full bg-current opacity-50" />
                          )}
                          <span>{step.label}</span>
                        </div>
                      );
                    })}
                  </div>
                </details>
              </motion.div>
            );
          }

          if (block.type === 'artifact') {
            return (
              <ArtifactCard
                key={`artifact-${block.artifact.id}`}
                artifact={block.artifact}
                onOpen={onOpenArtifact}
                onCompile={onCompileArtifact}
              />
            );
          }

          const statusStyles = getStatusStyles(block.status);
          return (
            <motion.div
              // eslint-disable-next-line react/no-array-index-key -- chat blocks are append-only stream output, index is stable
              key={`status-${index}`}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
            >
              <Card
                variant="default"
                padding="md"
                className="rounded-[16px] border shadow-[var(--shadow-sm)]"
                style={statusStyles.panelStyle}
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5">{statusStyles.icon}</div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium" style={statusStyles.titleStyle}>
                      {block.title}
                    </div>
                    {block.message && (
                      <div className="mt-1 text-sm leading-6" style={statusStyles.bodyStyle}>
                        {block.message}
                      </div>
                    )}
                  </div>
                </div>
              </Card>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
});

export const AssistantTaskCard = memo(function AssistantTaskCard({
  message,
  pending = false,
  onOpenArtifact,
  onCompileArtifact,
  onAcceptAutoFix,
  autoFixLabel,
}: {
  message: ChatMessage;
  pending?: boolean;
  onOpenArtifact: (artifact: ArtifactSummary) => void;
  onCompileArtifact: (artifact: ArtifactSummary) => void;
  onAcceptAutoFix: () => void;
  autoFixLabel?: string;
}) {
  const hasContent = hasVisibleMessageContent(message);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="w-full max-w-[760px]"
    >
      <div
        className="mb-1.5 flex items-center gap-2 text-[10px]"
        style={{ color: 'color-mix(in srgb, var(--color-text-secondary) 84%, white 16%)' }}
      >
        <div
          className="flex h-5 w-5 items-center justify-center rounded-full border"
          style={{
            borderColor: 'color-mix(in srgb, var(--color-accent) 18%, transparent)',
            background: 'color-mix(in srgb, var(--color-bg-primary) 88%, transparent)',
            boxShadow: 'var(--shadow-sm)',
          }}
        >
          <Orbit className="h-3 w-3 text-sky-600" />
        </div>
        <span
          className="font-medium"
          style={{ color: 'color-mix(in srgb, var(--color-text-primary) 82%, white 18%)' }}
        >
          {DISPLAY_NAME_BOT}
        </span>
        <span>{formatTimeLabel(message.timestamp)}</span>
      </div>

      <div className="pl-0 space-y-3">
        {hasContent ? (
          <ResearchMessageBlocks
            blocks={message.blocks}
            content={message.content}
            onOpenArtifact={onOpenArtifact}
            onCompileArtifact={onCompileArtifact}
          />
        ) : pending ? (
          <div
            className="flex items-center gap-3 rounded-2xl border px-4 py-3 text-sm"
            style={{
              borderColor: 'color-mix(in srgb, var(--color-accent) 28%, transparent)',
              background:
                'color-mix(in srgb, var(--color-accent) 18%, var(--color-bg-elevated) 82%)',
              color: 'var(--research-chat-body)',
            }}
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>{t('research.thinkingAndGenerating')}</span>
          </div>
        ) : (
          <div
            className="rounded-2xl border px-4 py-3 text-sm"
            style={{
              borderColor: 'var(--color-border-subtle)',
              background: 'color-mix(in srgb, var(--color-bg-elevated) 92%, transparent)',
              color: 'var(--color-text-muted)',
            }}
          >
            {t('research.noResultToDisplay')}
          </div>
        )}

        {shouldOfferAutoFix(message.content || '') && (
          <div className="mt-4">
            <Button
              type="button"
              size="sm"
              variant="primary"
              className="rounded-full px-4"
              onClick={onAcceptAutoFix}
              leftIcon={<Sparkles size={14} />}
            >
              {autoFixLabel || t('research.acceptAndModify')}
            </Button>
          </div>
        )}
      </div>
    </motion.div>
  );
});

export const OpenClawConfigNotice = memo(function OpenClawConfigNotice({
  title,
  description,
  onRetry,
  onOpenSettings,
}: {
  title: string;
  description: string;
  onRetry: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-8 py-16 text-center">
      <Card
        variant="default"
        padding="lg"
        className="w-full max-w-[620px] rounded-[24px]"
        style={{
          borderColor: 'var(--color-border)',
          background: 'color-mix(in srgb, var(--color-bg-elevated) 98%, transparent)',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[rgba(15,157,223,0.1)]">
          <Orbit className="h-6 w-6 text-sky-600" />
        </div>
        <div className="text-[22px] font-semibold tracking-[-0.03em] text-[var(--color-text-primary)]">
          {title}
        </div>
        <p className="mt-3 text-[14px] leading-7 text-[var(--color-text-muted)]">{description}</p>
        <div className="mt-6 flex items-center justify-center gap-3">
          <Button size="sm" variant="primary" className="rounded-full px-4" onClick={onRetry}>
            {t('research.retryConnection')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="rounded-full px-4"
            onClick={onOpenSettings}
          >
            {t('research.openSettings')}
          </Button>
        </div>
      </Card>
    </div>
  );
});
