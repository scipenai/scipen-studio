/**
 * @file ZoteroDiagnosticsPopover.tsx — Index diagnostics popover (above the StatusBar badge)
 * @description Synchronously renders mirror state slices (status / itemCount / lastSyncedAt),
 *              and asynchronously pulls full diagnostics from main (data-source health:
 *              Local API + Better BibTeX). Provides a "manual refresh" button that calls
 *              mirror.refresh() directly (main applies its own cooldown debounce).
 *
 *              The UI is mounted only when the StatusBar badge is clicked; unmount releases
 *              the fetchDiagnostics listener.
 */

import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import type React from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from '../../locales';
import type { ZoteroBibMirror, ZoteroBibMirrorState } from '../../services/zotero/ZoteroBibMirror';
import type { ZoteroDiagnosticsDTO } from '../../../../../shared/types/zotero-events';
import { createLogger } from '../../services/LogService';

const logger = createLogger('ZoteroDiagnosticsPopover');

interface Props {
  state: ZoteroBibMirrorState;
  mirror: ZoteroBibMirror;
  onClose: () => void;
}

export const ZoteroDiagnosticsPopover: React.FC<Props> = ({ state, mirror, onClose }) => {
  const { t } = useTranslation();
  const [diagnostics, setDiagnostics] = useState<ZoteroDiagnosticsDTO | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // On popover open, pull full diagnostics once (data-source health from main); the manual
  // refresh button re-pulls afterward.
  useEffect(() => {
    let cancelled = false;
    void mirror
      .fetchDiagnostics()
      .then((d) => {
        if (!cancelled) setDiagnostics(d);
      })
      .catch((err) => logger.warn('fetchDiagnostics failed', err));
    return () => {
      cancelled = true;
    };
  }, [mirror]);

  const onRefresh = async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await mirror.refresh();
      const d = await mirror.fetchDiagnostics();
      setDiagnostics(d);
    } catch (err) {
      logger.warn('refresh failed', err);
    } finally {
      setRefreshing(false);
    }
  };

  const sources = diagnostics?.sources;

  return (
    <div
      className="absolute bottom-full right-0 mb-1 w-72 rounded-xl py-2 z-50 text-[11px]"
      style={{
        background: 'var(--color-bg-secondary)',
        border: '1px solid var(--color-border)',
        boxShadow: 'var(--shadow-lg)',
        color: 'var(--color-text-secondary)',
      }}
    >
      <div
        className="px-3 pb-2 mb-1 font-semibold uppercase tracking-wider text-[11px]"
        style={{
          color: 'var(--color-text-muted)',
          borderBottom: '1px solid var(--color-border-subtle)',
        }}
      >
        {t('zotero.diagnostics.title')}
      </div>

      <Row
        label={t('zotero.diagnostics.status')}
        value={t(`zotero.status.${state.status}` as const)}
      />
      <Row label={t('zotero.diagnostics.itemCount')} value={String(state.itemCount)} />
      <Row
        label={t('zotero.diagnostics.lastSyncedAt')}
        value={state.lastSyncedAt ? formatTime(state.lastSyncedAt) : t('zotero.diagnostics.never')}
      />

      <div className="mx-3 my-1 border-t" style={{ borderColor: 'var(--color-border-subtle)' }} />

      <SourceRow
        label={t('zotero.diagnostics.localApi')}
        ok={sources?.localApi.ok ?? null}
        error={sources?.localApi.error}
      />
      <SourceRow
        label={t('zotero.diagnostics.betterBibTex')}
        ok={sources?.betterBibTex.ok ?? null}
        error={sources?.betterBibTex.error}
      />

      <div
        className="px-3 pt-2 mt-1 flex justify-end gap-2"
        style={{ borderTop: '1px solid var(--color-border-subtle)' }}
      >
        <button
          type="button"
          onClick={onClose}
          className="px-2 py-1 rounded hover:bg-[var(--color-bg-hover)]"
          style={{ color: 'var(--color-text-muted)' }}
        >
          {t('zotero.diagnostics.close')}
        </button>
        <button
          type="button"
          onClick={() => void onRefresh()}
          disabled={refreshing}
          className="flex items-center gap-1 px-2 py-1 rounded hover:bg-[var(--color-bg-hover)] disabled:opacity-50"
          style={{ color: 'var(--color-accent)' }}
        >
          <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
          {t('zotero.diagnostics.refresh')}
        </button>
      </div>
    </div>
  );
};

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="px-3 py-0.5 flex items-center justify-between">
    <span style={{ color: 'var(--color-text-muted)' }}>{label}</span>
    <span className="font-mono">{value}</span>
  </div>
);

const SourceRow: React.FC<{ label: string; ok: boolean | null; error?: string }> = ({
  label,
  ok,
  error,
}) => (
  <div className="px-3 py-0.5 flex items-center justify-between" title={error ?? ''}>
    <span style={{ color: 'var(--color-text-muted)' }}>{label}</span>
    {ok === null ? (
      <span className="font-mono text-[var(--color-text-disabled)]">…</span>
    ) : ok ? (
      <CheckCircle2 size={12} style={{ color: 'var(--color-success)' }} />
    ) : (
      <XCircle size={12} style={{ color: 'var(--color-error)' }} />
    )}
  </div>
);

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso;
  }
}
