/**
 * @file ZoteroStatusBadge.tsx — Zotero index status badge in the StatusBar
 * @description A small colored dot on the left (color mapped from BibStatus) + a hover tooltip
 *              showing "Zotero: ${status}". Clicking opens <ZoteroDiagnosticsPopover>
 *              (itemCount / lastSyncedAt / data-source health / manual refresh button).
 *              When the user has not enabled Zotero integration
 *              (`integrationEnabled=false`), returns null — no placeholder, no trace.
 *
 *              Data comes from useZoteroBibMirror (subscribed to the main-process canonical index).
 */

import type React from 'react';
import { useId, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useClickOutside } from '../../hooks';
import { useZoteroBibMirror } from '../../hooks/useZoteroBibMirror';
import { useTranslation } from '../../locales';
import { BIB_STATUS_COLOR, isBibStatusBusy } from '../../services/zotero/statusColor';
import { ZoteroDiagnosticsPopover } from './ZoteroDiagnosticsPopover';

export const ZoteroStatusBadge: React.FC = () => {
  const { t } = useTranslation();
  const { state, mirror, enabled } = useZoteroBibMirror();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();

  useClickOutside(containerRef, () => setOpen(false), open);

  if (!enabled) return null;

  const statusLabel = t(`zotero.status.${state.status}` as const);
  const tooltip = `${t('zotero.status.tooltipPrefix')}: ${statusLabel}`;
  const busy = isBibStatusBusy(state.status);

  return (
    <div
      ref={containerRef}
      className="relative h-full"
      style={{ borderLeft: '1px solid var(--color-border-subtle)' }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-3 h-full transition-colors cursor-pointer hover:bg-[var(--color-bg-hover)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
        title={tooltip}
        aria-label={tooltip}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? popoverId : undefined}
      >
        {busy ? (
          <Loader2
            size={10}
            className="animate-spin"
            style={{ color: BIB_STATUS_COLOR[state.status] }}
          />
        ) : (
          <span
            className="inline-block w-1.5 h-1.5 rounded-full"
            style={{ background: BIB_STATUS_COLOR[state.status] }}
          />
        )}
        <span
          className="hidden sm:inline text-[11px] font-medium"
          style={{ color: 'var(--color-text-muted)' }}
        >
          {t('zotero.status.label')}
        </span>
      </button>

      {open && (
        <ZoteroDiagnosticsPopover
          id={popoverId}
          state={state}
          mirror={mirror}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
};
