import {
  Braces,
  CheckCircle2,
  FileCode2,
  FileText,
  Loader2,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import { createElement } from 'react';
import type { ArtifactSummary, ChatMessage } from '../../../../../shared/types/chat';
import { t } from '../../locales';

export function shouldOfferAutoFix(content: string): boolean {
  return /帮你直接改好|帮我直接改好|直接修复|直接改吧|我帮你改好吗|告诉我我帮你直接改好|允许.*自动修复/i.test(
    content
  );
}

export function formatTimeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function hasVisibleMessageContent(message: ChatMessage): boolean {
  if (message.content.trim().length > 0) {
    return true;
  }

  return (message.blocks ?? []).some((block) => {
    if (block.type === 'artifact') return true;
    if (block.type === 'markdown') return block.content.trim().length > 0;
    return false;
  });
}

/** Display name constants — single source of truth across components */
export const DISPLAY_NAME_USER = 'User';
export const DISPLAY_NAME_BOT = 'SciPenClaw';

// IM-driven helpers (isBotMessage / buildIMFilePath) were removed in the
// P3 cleanup. Restore from git history if SNACA brings back a similar flow.

export function hasSystemErrorPrefix(content: string): boolean {
  const normalized = content.trim();
  return (
    normalized.startsWith('Error:') ||
    normalized.startsWith('⚠️ Error') ||
    normalized.startsWith('⚠ Error') ||
    normalized.startsWith('⚠️') ||
    normalized.startsWith('⚠') ||
    normalized.startsWith('Request failed') ||
    normalized.startsWith('Request timed out')
  );
}

/** Convert raw tool name to an i18n-friendly label; falls back to underscore-to-space. */
export function humanizeToolName(raw: string): string {
  const key = raw.trim().toLowerCase();
  const i18nKey = `tools.${key}`;
  // Dynamic key lookup — use the non-hook t() and bypass the strict key union.
  const translated = (t as unknown as (k: string) => string)(i18nKey);
  // If t() returned the key itself (i.e. no translation found), fall back to underscore-to-space.
  return translated !== i18nKey ? translated : raw.replace(/_/g, ' ');
}

export function splitToolUsageLine(content: string): {
  tools: string[];
  content: string;
} {
  const trimmed = content.trimStart();
  const match = trimmed.match(/^\[Used tools:\s*([^\]]+)\]\s*/i);
  if (!match) {
    return { tools: [], content };
  }

  const tools = match[1]
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const nextContent = trimmed.slice(match[0].length).trimStart();
  return { tools, content: nextContent };
}

export function getArtifactIcon(artifact: ArtifactSummary) {
  const lower = artifact.path.toLowerCase();
  if (lower.endsWith('.typ')) {
    return createElement(Sparkles, { className: 'h-5 w-5 text-[var(--color-info)]' });
  }
  if (lower.endsWith('.tex') || lower.endsWith('.ltx')) {
    return createElement(Braces, { className: 'h-5 w-5 text-[var(--color-success)]' });
  }
  return createElement(FileCode2, { className: 'h-5 w-5 text-[var(--color-text-muted)]' });
}

export function getArtifactSubtitle(path: string, language?: string | null): string {
  const normalized = path.replace(/\\/g, '/');
  const extension = normalized.split('.').pop()?.toUpperCase() || language?.toUpperCase() || 'FILE';
  return `${extension} · ${normalized}`;
}

export function getStatusStyles(status: 'info' | 'running' | 'success' | 'warning' | 'error') {
  switch (status) {
    case 'running':
      return {
        icon: createElement(Loader2, {
          className: 'h-4 w-4 animate-spin text-[var(--color-accent)]',
        }),
        panelStyle: {
          borderColor: 'color-mix(in srgb, var(--color-accent) 24%, transparent)',
          background:
            'color-mix(in srgb, var(--color-info-muted) 72%, var(--color-bg-elevated) 28%)',
        },
        titleStyle: { color: 'var(--color-text-primary)' },
        bodyStyle: { color: 'var(--color-text-secondary)' },
      };
    case 'success':
      return {
        icon: createElement(CheckCircle2, { className: 'h-4 w-4 text-[var(--color-success)]' }),
        panelStyle: {
          borderColor: 'color-mix(in srgb, var(--color-success) 24%, transparent)',
          background:
            'color-mix(in srgb, var(--color-success-muted) 72%, var(--color-bg-elevated) 28%)',
        },
        titleStyle: { color: 'var(--color-text-primary)' },
        bodyStyle: { color: 'var(--color-text-secondary)' },
      };
    case 'warning':
      return {
        icon: createElement(TriangleAlert, { className: 'h-4 w-4 text-[var(--color-warning)]' }),
        panelStyle: {
          borderColor: 'color-mix(in srgb, var(--color-warning) 24%, transparent)',
          background:
            'color-mix(in srgb, var(--color-warning-muted) 72%, var(--color-bg-elevated) 28%)',
        },
        titleStyle: { color: 'var(--color-text-primary)' },
        bodyStyle: { color: 'var(--color-text-secondary)' },
      };
    case 'error':
      return {
        icon: createElement(TriangleAlert, { className: 'h-4 w-4 text-[var(--color-error)]' }),
        panelStyle: {
          borderColor: 'color-mix(in srgb, var(--color-error) 24%, transparent)',
          background:
            'color-mix(in srgb, var(--color-error-muted) 72%, var(--color-bg-elevated) 28%)',
        },
        titleStyle: { color: 'var(--color-text-primary)' },
        bodyStyle: { color: 'var(--color-text-secondary)' },
      };
    default:
      return {
        icon: createElement(FileText, { className: 'h-4 w-4 text-[var(--color-text-muted)]' }),
        panelStyle: {
          borderColor: 'var(--color-border-subtle)',
          background: 'color-mix(in srgb, var(--color-bg-elevated) 94%, transparent)',
        },
        titleStyle: { color: 'var(--color-text-primary)' },
        bodyStyle: { color: 'var(--color-text-secondary)' },
      };
  }
}

export function humanizeAgentError(error: string | null): {
  title: string;
  description: string;
} {
  if (!error) {
    return {
      title: t('research.cannotConnectAgent'),
      description: t('research.noSessionAvailableDesc'),
    };
  }

  const normalized = error.toLowerCase();
  if (
    normalized.includes('fetch failed') ||
    normalized.includes('error invoking remote method') ||
    normalized.includes('network') ||
    normalized.includes('econnrefused')
  ) {
    return {
      title: t('research.cannotConnectAgent'),
      description: t('research.connectionFailedDesc'),
    };
  }

  return {
    title: t('research.assistantUnavailable'),
    description: error,
  };
}
