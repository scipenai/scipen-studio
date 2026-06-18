/**
 * @file ZoteroPaperPane — right-pane "Paper" tab. Displays the Zotero paper PDF and provides:
 *   (1) a "Deep Parse" button that triggers MinerU cloud parsing (opens the setup dialog first if no token), progress shown inline;
 *   (2) [Raw PDF | Parsed MD] toggle — once parsed, the structured markdown becomes viewable.
 *   The PDF is injected via Ctrl+Click on \cite{} through UIService.loadZoteroPaper.
 */

import type React from 'react';
import { useEffect, useState } from 'react';
import { AlertTriangle, FileText, Loader2, Sparkles } from 'lucide-react';
import { api } from '../../api';
import { useTranslation } from '../../locales';
import type { TranslationKey } from '../../locales';
import { useZoteroPdf, useZoteroPaperItemKey } from '../../services/core/hooks';
import type { MinerUParseStatusDTO } from '../../../../../shared/types/zotero-mineru';
import { MinerUSetupDialog } from '../onboarding/MinerUSetupDialog';
import { PdfPreviewPane } from './PdfPreviewPane';
import { ZoteroParsedMarkdownView } from './ZoteroParsedMarkdownView';

type ViewMode = 'pdf' | 'md';

export const ZoteroPaperPane: React.FC = () => {
  const { t } = useTranslation();
  const bytes = useZoteroPdf();
  const itemKey = useZoteroPaperItemKey();

  const [viewMode, setViewMode] = useState<ViewMode>('pdf');
  const [hasMd, setHasMd] = useState(false);
  const [status, setStatus] = useState<MinerUParseStatusDTO | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  // Tier-1 extraction quality: when 'poor', nudge the user to run deep parse (data comes from getFullText, cached).
  const [quality, setQuality] = useState<'good' | 'poor' | null>(null);

  // Probe whether the current item already has a parsed artifact (decides if the MD toggle is enabled) and subscribe to progress.
  useEffect(() => {
    if (!itemKey) {
      setHasMd(false);
      setStatus(null);
      setQuality(null);
      setViewMode('pdf');
      return;
    }
    let cancelled = false;
    void api.zotero.getParsedMarkdown(itemKey).then((r) => {
      if (!cancelled) setHasMd(r !== null);
    });
    // Probe tier-1 extraction quality (cache hit avoids re-running pdf-parse); show the hint banner when poor.
    void api.zotero.getFullText(itemKey).then((r) => {
      if (!cancelled) setQuality(r.quality ?? null);
    });
    const off = api.zotero.onMinerUProgress((s) => {
      if (s.itemKey !== itemKey) return;
      setStatus(s);
      if (s.state === 'done') {
        setHasMd(true);
        setViewMode('md');
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [itemKey]);

  if (!bytes || !itemKey) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-[var(--color-bg-secondary)]">
        <div className="px-6 text-center">
          <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-2xl bg-[var(--color-bg-tertiary)]">
            <FileText size={40} className="text-[var(--color-text-disabled)]" aria-hidden="true" />
          </div>
          <p className="font-medium text-[var(--color-text-secondary)]">{t('zoteroPaper.empty')}</p>
        </div>
      </div>
    );
  }

  const busy =
    status !== null &&
    status.state !== 'done' &&
    status.state !== 'failed' &&
    status.state !== 'idle';

  const startParse = async (): Promise<void> => {
    const settings = await api.zotero.getSettings();
    if (!settings.hasMinerUApiKey) {
      setDialogOpen(true);
      return;
    }
    await api.zotero.parseWithMinerU(itemKey);
  };

  const parseLabel = (): string => {
    if (!status || status.state === 'idle' || status.state === 'done') {
      return t('zoteroPaper.parseButton');
    }
    if (status.state === 'failed') {
      return t(`zoteroMineru.error.${mapErr(status.errorCode)}` as TranslationKey);
    }
    if (status.state === 'running' && status.totalPages) {
      return t('zoteroMineru.state.running', {
        extracted: String(status.extractedPages ?? 0),
        total: String(status.totalPages),
      });
    }
    return t(`zoteroMineru.state.${status.state}` as TranslationKey);
  };

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg-secondary)]">
      <div
        className="flex items-center gap-2 border-b px-3 py-2"
        style={{ borderBottomColor: 'var(--color-border-subtle)' }}
      >
        {/* PDF / MD toggle */}
        <div className="flex items-center gap-1 rounded-lg bg-[var(--color-bg-tertiary)] p-0.5">
          <SegBtn active={viewMode === 'pdf'} onClick={() => setViewMode('pdf')}>
            {t('zoteroPaper.viewPdf')}
          </SegBtn>
          <SegBtn
            active={viewMode === 'md'}
            disabled={!hasMd}
            title={hasMd ? undefined : t('zoteroPaper.mdUnavailable')}
            onClick={() => hasMd && setViewMode('md')}
          >
            {t('zoteroPaper.viewMarkdown')}
          </SegBtn>
        </div>

        <div className="flex-1" />

        {/* Deep parse */}
        <button
          type="button"
          onClick={() => void startParse()}
          disabled={busy}
          className="flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-60"
          title={t('zoteroPaper.parseButton')}
        >
          {busy ? (
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          ) : (
            <Sparkles size={13} aria-hidden="true" />
          )}
          <span>{parseLabel()}</span>
        </button>
      </div>

      {/* Tier-1 quality warning: only shown in PDF view when no parsed artifact exists; guides the user to deep parse. */}
      {quality === 'poor' && viewMode === 'pdf' && !hasMd && (
        <div
          className="flex items-center gap-2 border-b px-3 py-2 text-xs"
          style={{
            borderBottomColor: 'var(--color-border-subtle)',
            background: 'var(--color-warning-muted, rgba(234,179,8,0.12))',
            color: 'var(--color-text-secondary)',
        }}
      >
          <AlertTriangle
            size={13}
            className="shrink-0 text-[var(--color-warning,#eab308)]"
            aria-hidden="true"
          />
          <span className="flex-1">{t('zoteroPaper.qualityPoor')}</span>
          <button
            type="button"
            onClick={() => void startParse()}
            disabled={busy}
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 py-1 font-medium text-[var(--color-accent)] hover:bg-[var(--color-accent-muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Sparkles size={13} aria-hidden="true" />
            {t('zoteroPaper.parseButton')}
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {viewMode === 'md' && hasMd ? (
          <ZoteroParsedMarkdownView itemKey={itemKey} />
        ) : (
          <PdfPreviewPane source="zotero" />
        )}
      </div>

      <MinerUSetupDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onConfirmed={() => void api.zotero.parseWithMinerU(itemKey)}
      />
    </div>
  );
};

const SegBtn: React.FC<{
  active: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ active, disabled, title, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-pressed={active}
    title={title}
    className="cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40"
    style={
      active
        ? { background: 'var(--color-bg-elevated)', color: 'var(--color-text-primary)' }
        : { color: 'var(--color-text-muted)' }
    }
  >
    {children}
  </button>
);

/** Error code -> i18n key suffix. */
function mapErr(code?: string): string {
  switch (code) {
    case 'MINERU_NO_TOKEN':
      return 'noToken';
    case 'A0202':
    case 'A0211':
      return 'tokenInvalid';
    case '-60005':
      return 'fileTooLarge';
    case '-60006':
      return 'tooManyPages';
    case '-60018':
      return 'quotaExhausted';
    case 'MINERU_TIMEOUT':
      return 'timeout';
    default:
      return 'generic';
  }
}
