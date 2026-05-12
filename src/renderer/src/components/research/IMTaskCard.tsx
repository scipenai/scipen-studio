import { motion } from 'framer-motion';
import { FileDiff, FileText, Loader2, Orbit, Paperclip, Sparkles } from 'lucide-react';
import { memo, useMemo } from 'react';
import type { StudioIMMessageDTO } from '../../../../../shared/api-types';
import { t } from '../../locales';
import { parseMessageAttachments } from '../../services/AtMentionResolver';
import { normalizeReviewPath } from '../../services/core/DiffReviewService';
import { usePendingReviews, useProjectRuntime } from '../../services/core/hooks';
import { MarkdownContent } from '../chat/MarkdownContent';
import { Button } from '../ui';
import {
  DISPLAY_NAME_BOT,
  DISPLAY_NAME_USER,
  buildIMFilePath,
  getArtifactSubtitle,
  hasSystemErrorPrefix,
  humanizeToolName,
  isBotMessage,
  shouldOfferAutoFix,
  splitToolUsageLine,
} from './conversationHelpers';

export const IMTaskCard = memo(function IMTaskCard({
  message,
  botUserId,
  onOpenFile,
  onCompileFile,
  onAcceptAutoFix,
  autoFixLabel,
  showPendingReviewBanner,
  isHistorical = false,
}: {
  message: StudioIMMessageDTO;
  botUserId?: string;
  onOpenFile: (filePath: string) => void;
  onCompileFile: (filePath: string) => void;
  onAcceptAutoFix: () => void;
  autoFixLabel?: string;
  showPendingReviewBanner: boolean;
  isHistorical?: boolean;
}) {
  const runtime = useProjectRuntime();
  const pendingReviews = usePendingReviews();
  const isUser = !isBotMessage(message, botUserId);
  const isStreaming = message.metadata?.streaming === true;
  const filePath = buildIMFilePath(message);
  const canCompile = Boolean(filePath && /\.(typ|tex|ltx)$/i.test(filePath));
  // Context-aware: hide the "open file" button when the file is already open in the editor.
  const { tools, content } = splitToolUsageLine(message.content || '');
  const { text: visibleText, attachments } = useMemo(
    () => parseMessageAttachments(content || ''),
    [content]
  );
  const trimmedContent = visibleText.trim();
  const isSystemError = hasSystemErrorPrefix(trimmedContent);
  const pendingProposalPaths = useMemo(() => {
    return new Set(
      pendingReviews
        .filter((review) => review.sourceMessageId === message.id)
        .map((review) => review.normalizedFilePath)
    );
  }, [message.id, pendingReviews]);

  if (isUser) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="ml-auto w-full max-w-[560px]"
      >
        <div className="mb-1.5 flex items-center justify-end gap-2 pr-2 text-[10px] text-[var(--color-text-muted)]">
          <span className="font-medium">{DISPLAY_NAME_USER}</span>
          <span>
            {new Date(message.created_at).toLocaleTimeString('zh-CN', {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        </div>
        <div
          className="rounded-[20px] px-4 py-3 text-[14px] leading-[1.75] shadow-[var(--shadow-sm)] ring-1 ring-inset"
          style={{
            background: 'var(--research-chat-user-bg)',
            color: 'var(--research-chat-body)',
            borderColor: 'var(--research-chat-user-border)',
            boxShadow: '0 14px 30px color-mix(in srgb, var(--color-accent) 12%, transparent)',
          }}
        >
          {trimmedContent ? (
            <MarkdownContent content={visibleText} className="chat-markdown" />
          ) : attachments.length === 0 ? (
            <div className="text-sm text-[var(--color-text-muted)]">
              {t('research.emptyMessage')}
            </div>
          ) : null}
          {attachments.length > 0 && (
            <div
              className={`flex flex-wrap gap-1.5 ${trimmedContent ? 'mt-2.5' : ''}`}
              aria-label={t('chatInput.attachedFiles')}
            >
              {attachments.map((file) => (
                <span
                  key={file.path}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]"
                  style={{
                    borderColor: 'color-mix(in srgb, var(--color-accent) 28%, transparent)',
                    background: 'color-mix(in srgb, var(--color-accent) 10%, transparent)',
                    color: 'var(--color-accent)',
                  }}
                  title={`${file.path} (${file.sizeBytes} bytes${file.truncated ? ', truncated' : ''})`}
                >
                  <Paperclip size={11} />
                  <span className="truncate max-w-[200px]">{file.name}</span>
                  {file.truncated && <span className="text-[10px] opacity-70">…</span>}
                </span>
              ))}
            </div>
          )}
        </div>
      </motion.div>
    );
  }

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
        <span>
          {new Date(message.created_at).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
      </div>

      <div className="pl-0 space-y-3">
        {tools.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {tools.map((tool) => (
              <span
                key={tool}
                className="rounded-full border px-2.5 py-1 text-[11px] font-medium"
                style={{
                  borderColor: 'color-mix(in srgb, var(--color-accent) 20%, transparent)',
                  background:
                    'color-mix(in srgb, var(--color-accent) 18%, var(--color-bg-primary) 82%)',
                  color: 'var(--research-chat-body)',
                }}
              >
                {humanizeToolName(tool)}
              </span>
            ))}
          </div>
        )}

        {trimmedContent ? (
          <div className="relative">
            {isSystemError ? (
              isHistorical ? (
                <details
                  className="max-w-[85%] overflow-hidden rounded-2xl border"
                  style={{
                    borderColor: 'color-mix(in srgb, var(--color-error) 22%, transparent)',
                    background:
                      'color-mix(in srgb, var(--color-error-muted) 76%, var(--color-bg-elevated) 24%)',
                  }}
                >
                  <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-sm font-medium text-[var(--color-error)]">
                    <span>⚠️</span>
                    <span className="truncate">{t('research.historicalErrorSummary')}</span>
                  </summary>
                  <div
                    className="border-t px-3 py-3 text-sm text-[var(--color-error)]"
                    style={{
                      borderTopColor: 'color-mix(in srgb, var(--color-error) 18%, transparent)',
                    }}
                  >
                    <p>{trimmedContent}</p>
                  </div>
                </details>
              ) : (
                <div
                  className="flex max-w-[85%] items-start gap-2 rounded-lg border p-3 text-sm text-[var(--color-error)]"
                  style={{
                    borderColor: 'color-mix(in srgb, var(--color-error) 22%, transparent)',
                    background:
                      'color-mix(in srgb, var(--color-error-muted) 76%, var(--color-bg-elevated) 24%)',
                  }}
                >
                  <span className="mt-0.5">⚠️</span>
                  <p>{trimmedContent}</p>
                </div>
              )
            ) : (
              <>
                <div
                  className="max-w-[680px] rounded-[18px] border px-4 py-3"
                  style={{
                    borderColor: 'var(--research-chat-assistant-border)',
                    background: 'var(--research-chat-assistant-bg)',
                    boxShadow: '0 16px 32px rgba(0, 0, 0, 0.18)',
                  }}
                >
                  <MarkdownContent content={trimmedContent} className="chat-markdown" />
                </div>
                {isStreaming && <span className="streaming-cursor" />}
              </>
            )}
          </div>
        ) : isStreaming ? (
          <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>{t('research.thinkingAndGenerating')}</span>
          </div>
        ) : tools.length === 0 ? (
          <div className="text-sm text-[var(--color-text-muted)]">{t('research.emptyMessage')}</div>
        ) : null}

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

        {/* AI edit proposal cards */}
        {message.metadata?.proposals && message.metadata.proposals.length > 0 && (
          <div className="mt-3 space-y-2">
            {message.metadata.proposals.map((proposal) => {
              const rootPath =
                message.metadata?.collaboration?.root_path
                  ?.replace(/\\/g, '/')
                  .replace(/\/+$/, '') || runtime.rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
              const proposalFullPath = rootPath
                ? `${rootPath}/${proposal.file_path.replace(/\\/g, '/').replace(/^\/+/, '')}`
                : proposal.file_path;
              const isPending = pendingProposalPaths.has(normalizeReviewPath(proposalFullPath));
              return (
                <div
                  key={proposal.file_path}
                  className="flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-[12px] shadow-[var(--shadow-sm)] cursor-pointer transition-colors hover:brightness-95"
                  style={{
                    borderColor: isPending
                      ? 'color-mix(in srgb, var(--color-accent) 22%, transparent)'
                      : 'color-mix(in srgb, var(--color-success, #22c55e) 22%, transparent)',
                    background: isPending
                      ? 'color-mix(in srgb, var(--color-accent) 8%, var(--color-bg-elevated) 92%)'
                      : 'color-mix(in srgb, var(--color-success, #22c55e) 6%, var(--color-bg-elevated) 94%)',
                    color: 'var(--color-text-primary)',
                  }}
                  onClick={() => onOpenFile(proposalFullPath)}
                >
                  <FileDiff
                    className={`h-4 w-4 flex-shrink-0 ${isPending ? 'text-sky-600' : 'text-emerald-500'}`}
                  />
                  <div className="min-w-0 flex-1">
                    <span className="font-medium">{proposal.file_path}</span>
                    {proposal.description && (
                      <span className="ml-2 text-[var(--color-text-muted)]">
                        — {proposal.description}
                      </span>
                    )}
                  </div>
                  <span
                    className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                    style={
                      isPending
                        ? {
                            background: 'color-mix(in srgb, var(--color-accent) 18%, transparent)',
                            color: 'var(--color-accent)',
                          }
                        : {
                            background:
                              'color-mix(in srgb, var(--color-success, #22c55e) 14%, transparent)',
                            color: 'var(--color-success, #22c55e)',
                          }
                    }
                  >
                    {isPending ? t('diffReview.pendingReview') : t('diffReview.reviewApplied')}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {(filePath || message.file_name) && showPendingReviewBanner ? (
          <div
            className="mt-3 flex items-center gap-2 rounded-xl border px-3 py-2 text-[12px] shadow-[var(--shadow-sm)]"
            style={{
              borderColor: 'color-mix(in srgb, var(--color-warning) 24%, transparent)',
              background:
                'color-mix(in srgb, var(--color-warning-muted) 78%, var(--color-bg-elevated) 22%)',
              color: 'var(--color-warning)',
            }}
          >
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
            <span>{t('diffReview.pendingReview')}</span>
            <span style={{ color: 'color-mix(in srgb, var(--color-warning) 60%, transparent)' }}>
              ·
            </span>
            <span
              style={{
                color:
                  'color-mix(in srgb, var(--color-warning) 82%, var(--color-text-primary) 18%)',
              }}
            >
              {message.file_name || filePath?.split('/').pop()}
            </span>
          </div>
        ) : (filePath || message.file_name) && isHistorical ? (
          <div
            className="mt-3 flex max-w-[560px] items-center gap-2 rounded-full border px-3 py-2 text-[12px]"
            style={{
              borderColor: 'var(--color-border-subtle)',
              background: 'color-mix(in srgb, var(--color-bg-elevated) 92%, transparent)',
              color: 'var(--color-text-muted)',
            }}
          >
            <FileText className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />
            <span className="min-w-0 flex-1 truncate">
              {t('research.compactFileAttachment', {
                fileName: message.file_name || filePath?.split('/').pop() || t('research.file'),
              })}
            </span>
          </div>
        ) : filePath || message.file_name ? (
          <div
            className="mt-4 max-w-[620px] rounded-[16px] border p-4 shadow-[var(--shadow-sm)]"
            style={{
              borderColor: 'var(--research-chat-embed-border)',
              background: 'var(--research-chat-embed-bg)',
              boxShadow: '0 16px 34px rgba(0, 0, 0, 0.18)',
            }}
          >
            <div className="text-sm font-medium text-[var(--color-text-primary)]">
              {message.file_name || filePath?.split('/').pop() || t('research.file')}
            </div>
            {filePath && (
              <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                {getArtifactSubtitle(filePath)}
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {filePath && (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="rounded-full px-3.5"
                  onClick={() => onOpenFile(filePath)}
                >
                  {t('research.openFile')}
                </Button>
              )}
              {filePath && canCompile && (
                <Button
                  type="button"
                  size="sm"
                  variant="primary"
                  className="rounded-full px-3.5"
                  onClick={() => onCompileFile(filePath)}
                >
                  {t('research.compilePreview')}
                </Button>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </motion.div>
  );
});
