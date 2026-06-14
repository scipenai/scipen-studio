/**
 * @file ProjectCitedReferencesPanel — Outline-style mini-panel that
 *   lists every citation actually used in the currently-active file.
 *
 * Why this exists alongside Zotero's own library UI (PM-5): Zotero shows
 * the entire library; the writer cares about "what did I cite in this
 * paper?" — a tiny subset that Zotero can't surface in this shape. We
 * keep the panel deliberately narrow: tap an entry to jump to the
 * citation site, click again to open the next occurrence.
 *
 * Data flow:
 *   active file content -> CitedKeyExtractor -> per-key occurrence list
 *                                            -> ZoteroBibIndex lookup
 *                                            -> render
 *
 * The panel listens to `editor.onDidChangeActiveTab` and content edits,
 * but recomputes lazily (debounced) so heavy files don't churn while
 * the user types.
 */

import { ChevronDown, ChevronRight, BookOpen } from 'lucide-react';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import type { ZoteroItemDTO } from '../../../../../shared/types/zotero';
import { useTranslation } from '../../locales';
import { getEditorService, getUIService } from '../../services/core';
import { useActiveTab } from '../../services/core/hooks';
import { SyncEventType } from '../../services/core/PreviewTypes';
import { extractCitedKeys, type CitedKeyOccurrence } from '../../services/zotero/CitedKeyExtractor';
import {
  getZoteroBibMirror,
  type ZoteroBibMirrorState,
} from '../../services/zotero/ZoteroBibMirror';

interface CitedEntry {
  key: string;
  occurrences: CitedKeyOccurrence[];
  entry?: ZoteroItemDTO;
}

const EXTRACT_DEBOUNCE_MS = 250;

export const ProjectCitedReferencesPanel: React.FC = () => {
  const { t } = useTranslation();
  const activeTab = useActiveTab();
  // Collapsed by default: when the drawer opens we don't grab attention; the user has to
  // click the header to expand this file's citation list.
  const [collapsed, setCollapsed] = useState(true);
  const [content, setContent] = useState<string>('');
  const [bibState, setBibState] = useState<ZoteroBibMirrorState>(() =>
    getZoteroBibMirror().getState()
  );

  // ----- Track active file content (debounced) -----
  useEffect(() => {
    if (!activeTab) {
      setContent('');
      return;
    }
    const editorService = getEditorService();
    setContent(activeTab.content ?? '');

    let timer: ReturnType<typeof setTimeout> | null = null;
    const dispose = editorService.onDidChangeContent((event) => {
      if (event.path !== activeTab.path) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setContent(event.content), EXTRACT_DEBOUNCE_MS);
    });

    return () => {
      if (timer) clearTimeout(timer);
      dispose.dispose();
    };
  }, [activeTab]);

  // ----- Subscribe to mirror state for "loading…" hint -----
  useEffect(() => {
    const mirror = getZoteroBibMirror();
    setBibState(mirror.getState());
    return mirror.subscribe(() => setBibState(mirror.getState()));
  }, []);

  // ----- Extract cited keys + join with mirror -----
  // bibState enters the dependency list: once the mirror finishes its async hydrate, we
  // re-join to pick up title/meta.
  const cited = useMemo<CitedEntry[]>(() => {
    if (!content) return [];
    const occurrences = extractCitedKeys(content);
    if (occurrences.length === 0) return [];
    const mirror = getZoteroBibMirror();

    const grouped = new Map<string, CitedKeyOccurrence[]>();
    for (const occ of occurrences) {
      const list = grouped.get(occ.key);
      if (list) list.push(occ);
      else grouped.set(occ.key, [occ]);
    }

    return Array.from(grouped.entries()).map(([key, occs]) => ({
      key,
      occurrences: occs,
      entry: mirror.getByCitationKey(key) ?? mirror.getByItemKey(key),
    }));
    // bibState.etag is the mirror's data version number: when etag changes the mirror has
    // hydrated / a patch has landed, and we re-join to pick up the latest title/meta. The
    // mirror itself is a singleton, so it stays out of the deps array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, bibState.etag]);

  const jumpTo = (occ: CitedKeyOccurrence) => {
    if (!activeTab) return;
    // Reuse the preview→editor event bus that the SyncTeX path already
    // listens to (editorSetup.ts:86-92). Same effect: reveal + caret +
    // focus on the target line.
    getUIService().firePreviewToEditor({
      type: SyncEventType.CLICK_TO_SOURCE,
      line: occ.line,
      column: occ.column,
      filePath: activeTab.path,
    });
  };

  if (!activeTab) return null;

  return (
    <div className="border-t border-[var(--color-border)] bg-[var(--color-bg-primary)]">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
      >
        <span className="flex items-center gap-1.5">
          <BookOpen className="h-3 w-3" />
          {t('projectCitedReferences.title')}
          <span className="text-[10px] font-normal opacity-70">({cited.length})</span>
        </span>
        {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>

      {!collapsed && (
        <div className="max-h-64 overflow-y-auto">
          {cited.length === 0 ? (
            <EmptyHint
              hint={
                !bibState.ready || bibState.itemCount === 0
                  ? t('projectCitedReferences.emptyNoIndex')
                  : t('projectCitedReferences.emptyNoCites')
              }
            />
          ) : (
            <ul role="list" className="py-1">
              {cited.map(({ key, occurrences, entry }) => (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() => jumpTo(occurrences[0])}
                    title={
                      occurrences.length > 1
                        ? t('projectCitedReferences.firstOf', { n: occurrences.length })
                        : undefined
                    }
                    className="block w-full px-3 py-1 text-left text-[12px] hover:bg-[var(--color-bg-hover)]"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-mono text-[11px] text-[var(--color-text-primary)]">
                        {entry?.citationKey ?? key}
                      </span>
                      {occurrences.length > 1 && (
                        <span className="text-[10px] text-[var(--color-text-muted)]">
                          ×{occurrences.length}
                        </span>
                      )}
                    </div>
                    {entry?.title && (
                      <div
                        className="mt-0.5 truncate text-[11px] text-[var(--color-text-secondary)]"
                        title={entry.title}
                      >
                        {entry.title}
                      </div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

const EmptyHint: React.FC<{ hint: string }> = ({ hint }) => (
  <div className="px-3 py-2 text-[11px] text-[var(--color-text-muted)]">{hint}</div>
);
