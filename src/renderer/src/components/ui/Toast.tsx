/**
 * @file Toast.tsx - Transient notification toasts
 * @description Non-modal, auto-dismissing notices for background events the
 *   user should know about but must not be interrupted by (a generated
 *   bibliography file, a finished export, a recovered connection).
 *
 * Ownership split, matching the rest of the renderer:
 *   - UIService owns the toast list + emits on change (framework-free state).
 *   - `ToastHost` renders it, mounted once in App.tsx.
 *   - Callers use `getUIService().showToast(...)` from anywhere, including
 *     non-React service code — no context/provider plumbing required.
 *
 * Modal confirmation is NOT this component's job: destructive or blocking
 * questions keep using `api.dialog.confirm` (native) or `Modal`.
 */

import { clsx } from 'clsx';
import { AlertCircle, AlertTriangle, CheckCircle, Info, X } from 'lucide-react';
import type React from 'react';
import { useTranslation } from '../../locales';
import { getUIService, useToasts } from '../../services/core';
import type { ToastKind, ToastMessage } from '../../services/core/UIService';

const ICONS: Record<ToastKind, React.ComponentType<{ size?: number; className?: string }>> = {
  info: Info,
  success: CheckCircle,
  warning: AlertTriangle,
  error: AlertCircle,
};

/** Accent color per kind; keys match the CSS custom properties in theme.css. */
const ACCENTS: Record<ToastKind, string> = {
  info: 'var(--color-accent)',
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
  error: 'var(--color-error)',
};

function ToastItem({ toast }: { toast: ToastMessage }): React.ReactElement {
  const { t } = useTranslation();
  const Icon = ICONS[toast.kind];
  const accent = ACCENTS[toast.kind];
  const dismiss = (): void => getUIService().dismissToast(toast.id);

  return (
    <div
      // Errors/warnings interrupt assistive tech; info/success are polite.
      role={toast.kind === 'error' || toast.kind === 'warning' ? 'alert' : 'status'}
      className="pointer-events-auto flex w-[min(380px,calc(100vw-2rem))] items-start gap-2.5 rounded-lg border px-3 py-2.5 shadow-[var(--shadow-lg)]"
      style={{
        borderColor: 'var(--color-border)',
        background: 'color-mix(in srgb, var(--color-bg-elevated) 96%, transparent)',
      }}
    >
      <Icon size={15} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-xs leading-relaxed text-[var(--color-text-primary)]">
          {toast.message}
        </div>
        {toast.actionLabel && (
          <button
            type="button"
            onClick={() => {
              toast.onAction?.();
              dismiss();
            }}
            className="mt-1.5 cursor-pointer rounded text-[11px] font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
            style={{ color: accent }}
          >
            {toast.actionLabel}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('common.close')}
        title={t('common.close')}
        className="flex-shrink-0 cursor-pointer rounded p-0.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
      >
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * Fixed-position stack, newest at the bottom. Mounted once by App.tsx.
 * `pointer-events-none` on the container so the empty area never blocks
 * clicks on the UI underneath; each toast re-enables them for itself.
 */
export function ToastHost({ className }: { className?: string }): React.ReactElement | null {
  const toasts = useToasts();
  if (toasts.length === 0) return null;

  return (
    <div
      className={clsx(
        'pointer-events-none fixed bottom-12 right-4 z-[60] flex flex-col gap-2',
        className
      )}
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
