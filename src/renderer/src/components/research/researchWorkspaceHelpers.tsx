import { PanelResizeHandle } from 'react-resizable-panels';
import type { ArtifactSummary, ChatMessage } from '../../../../../shared/types/chat';
import type { AskAIAboutErrorRequest } from '../../services/core/UIService';
import { t } from '../../locales';

// ─── Constants ─────────────────────────────────────

export const HIDDEN_CONTEXT_START = '[SCIPEN_HIDDEN_CONTEXT]';
export const HIDDEN_CONTEXT_END = '[/SCIPEN_HIDDEN_CONTEXT]';
/** Max characters for hidden context. IM server limits messages to 50000; leave budget for the visible body and metadata. */
export const HIDDEN_CONTEXT_MAX_CHARS = 30_000;

// ─── Types ─────────────────────────────────────────

export interface ErrorContextBadge {
  id: string;
  label: string;
  tone?: 'info' | 'warning' | 'danger';
  removable?: boolean;
}

export interface PendingErrorDraftContext {
  hiddenContext: string;
  badges: ErrorContextBadge[];
}

// ─── Pure utility functions ────────────────────────

export function getRelativePath(filePath: string | undefined, projectPath: string | null): string {
  if (!filePath) return '';
  const normalizedFile = filePath.replace(/\\/g, '/');
  const normalizedProject = projectPath?.replace(/\\/g, '/');
  if (normalizedProject && normalizedFile.startsWith(`${normalizedProject}/`)) {
    return normalizedFile.slice(normalizedProject.length + 1);
  }
  return normalizedFile.split('/').pop() || normalizedFile;
}

export function truncateHiddenContext(body: string): string {
  if (body.length <= HIDDEN_CONTEXT_MAX_CHARS) {
    return `${HIDDEN_CONTEXT_START}\n${body}\n${HIDDEN_CONTEXT_END}`;
  }
  // Compile errors are usually at the tail of the log; keep the first 20% and last 80%.
  const headSize = Math.floor(HIDDEN_CONTEXT_MAX_CHARS * 0.2);
  const tailSize = HIDDEN_CONTEXT_MAX_CHARS - headSize;
  const content = `${body.slice(0, headSize)}\n\n... (middle truncated) ...\n\n${body.slice(-tailSize)}`;
  return `${HIDDEN_CONTEXT_START}\n${content}\n${HIDDEN_CONTEXT_END}`;
}

export function normalizePromptPayload(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (value instanceof Error) {
    return value.message?.trim() || value.name;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['message', 'error', 'raw', 'text', 'detail']) {
      const candidate = obj[key];
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function buildWorkspaceInputPlaceholder(
  filePath: string | null,
  projectPath: string | null
): string {
  if (filePath) {
    const fileName = filePath.replace(/\\/g, '/').split('/').pop() || filePath;
    return t('research.modifyFileHint', { fileName });
  }
  if (projectPath) {
    const projectName =
      projectPath.replace(/\\/g, '/').split('/').pop() || t('research.currentProject');
    return t('research.projectHint', { projectName });
  }
  return t('research.defaultHint');
}

export function buildAskPromptPartsFromCompileError(
  request: AskAIAboutErrorRequest,
  projectPath: string | null
): { visiblePrompt: string; hiddenContext: string } {
  const normalizedError =
    normalizePromptPayload(request.errorMessage) || t('research.compileFailed');
  const normalizedDetail = normalizePromptPayload(request.errorContent);
  const displayPath = getRelativePath(request.file, projectPath);
  const visiblePrompt = displayPath
    ? t('research.helpFixFileError', { displayPath })
    : t('research.helpFixError');
  if ((request.relatedEntries?.length ?? 0) > 0 || request.rawLog?.trim()) {
    const relatedBlock =
      request.relatedEntries && request.relatedEntries.length > 0
        ? request.relatedEntries
            .map((entry, index) => {
              const entryDisplayPath = getRelativePath(entry.file, projectPath);
              const location =
                entryDisplayPath && entry.line != null
                  ? `${entryDisplayPath}:${entry.line}`
                  : entryDisplayPath || '';
              return `${index + 1}. ${location ? `[${location}] ` : ''}${entry.message}${
                entry.content ? `\n${entry.content.trim()}` : ''
              }`;
            })
            .join('\n\n')
        : null;

    const visibleParts = [visiblePrompt];
    const hiddenParts = [
      request.summaryTitle || t('research.analyzeCompileFailure'),
      normalizedError ? t('research.coreError', { error: normalizedError }) : null,
      displayPath ? t('research.filePath', { path: displayPath }) : null,
      normalizedDetail ? t('research.detailContent', { detail: normalizedDetail }) : null,
      relatedBlock ? t('research.structuredErrorList', { list: relatedBlock }) : null,
      request.rawLog ? t('research.fullRawLog', { log: request.rawLog.trim() }) : null,
      t('research.requestFixSuggestion'),
    ].filter(Boolean);

    if (hiddenParts.length === 0) {
      return {
        visiblePrompt: visibleParts.filter(Boolean).join('\n\n'),
        hiddenContext: '',
      };
    }

    return {
      visiblePrompt: visibleParts.filter(Boolean).join('\n\n'),
      hiddenContext: truncateHiddenContext(hiddenParts.join('\n\n')),
    };
  }

  const parts = [
    request.summaryTitle || t('research.analyzeCurrentError'),
    t('research.errorInfo', { error: normalizedError }),
    displayPath ? t('research.filePath', { path: displayPath }) : null,
    normalizedDetail ? t('research.detailContentInline', { detail: normalizedDetail }) : null,
    request.sourceContext ? t('research.relatedSource', { source: request.sourceContext }) : null,
    t('research.requestFixSuggestion'),
  ];
  return {
    visiblePrompt,
    hiddenContext: truncateHiddenContext(parts.filter(Boolean).join('\n\n')),
  };
}

export function buildErrorContextBadges(
  request: AskAIAboutErrorRequest,
  projectPath: string | null
): ErrorContextBadge[] {
  const displayPath = getRelativePath(request.file, projectPath);
  const badges: ErrorContextBadge[] = [
    {
      id: 'compile-context',
      label: t('research.errorContextAttached'),
      tone: 'warning',
      removable: true,
    },
    {
      id: 'compile-type',
      label: t('research.errorContextCompiler', { compiler: request.compilerType }),
      tone: 'info',
    },
  ];

  if (displayPath || request.line) {
    badges.push({
      id: 'compile-location',
      label: request.line
        ? t('research.errorContextLocation', {
            path: displayPath || t('research.currentProject'),
            line: String(request.line),
          })
        : t('research.errorContextLocationShort', {
            path: displayPath || t('research.currentProject'),
          }),
      tone: 'info',
    });
  }

  if (request.rawLog?.trim() || (request.relatedEntries?.length ?? 0) > 0) {
    badges.push({
      id: 'compile-log',
      label: t('research.errorContextLogAttached'),
      tone: 'danger',
    });
  }

  return badges;
}

export function findLatestArtifact(
  messages: ChatMessage[],
  filePath: string
): ArtifactSummary | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const blocks = messages[index].blocks ?? [];
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex];
      if (block.type === 'artifact' && block.artifact.path === filePath) {
        return block.artifact;
      }
    }
  }
  return null;
}

export function getOpenClawStatus(params: {
  hasIMConfig: boolean;
  hasActiveConversation: boolean;
  isConnected: boolean;
  isConnecting: boolean;
  connectionState: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
  isHydrating: boolean;
  desiredProjectScope: boolean;
  activeConversationScope: 'global' | 'project' | null;
  scopeError: string | null;
}): {
  tone: 'success' | 'warning' | 'info';
  text: string;
} {
  if (!params.hasIMConfig) {
    return { tone: 'warning', text: t('research.imNotConfigured') };
  }
  if (params.isHydrating) {
    return { tone: 'info', text: t('research.restoringContext') };
  }
  if (params.scopeError && params.hasActiveConversation) {
    return { tone: 'warning', text: params.scopeError };
  }
  if (params.hasActiveConversation && params.isConnected) {
    return {
      tone: 'success',
      text:
        params.activeConversationScope === 'project'
          ? t('research.projectSessionConnected')
          : t('research.globalSessionConnected'),
    };
  }
  if (
    params.hasActiveConversation &&
    (params.isConnecting ||
      params.connectionState === 'connecting' ||
      params.connectionState === 'reconnecting')
  ) {
    return {
      tone: 'info',
      text:
        params.activeConversationScope === 'project'
          ? t('research.projectSessionConnecting')
          : t('research.globalSessionConnecting'),
    };
  }
  if (params.hasActiveConversation) {
    return {
      tone: 'warning',
      text:
        params.activeConversationScope === 'project'
          ? t('research.projectSessionDisconnected')
          : t('research.globalSessionDisconnected'),
    };
  }
  if (params.desiredProjectScope) {
    return { tone: 'warning', text: t('research.noProjectConversation') };
  }
  return { tone: 'warning', text: t('research.noAvailableSession') };
}

export function getConversationScopeBadge(scopeType: 'global' | 'project' | null): string {
  if (scopeType === 'project') return t('research.projectSession');
  if (scopeType === 'global') return t('research.globalSession');
  return t('research.sessionUnbound');
}

export function getChatPanelDefaultSize(
  workspaceMode: 'chat' | 'chat-editor' | 'chat-editor-preview'
): number {
  if (workspaceMode === 'chat-editor-preview') return 24;
  if (workspaceMode === 'chat-editor') return 28;
  return 100;
}

// ─── Small components ──────────────────────────────

export const WorkspaceResizeHandle = () => (
  <PanelResizeHandle className="group relative w-2 bg-transparent transition-colors">
    <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[var(--color-border-subtle)] transition-colors group-hover:bg-[var(--color-accent)]" />
    <div className="absolute left-1/2 top-1/2 h-10 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-transparent transition-colors group-hover:bg-[var(--color-accent-muted)]" />
  </PanelResizeHandle>
);
