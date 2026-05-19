/**
 * @file MemoryPane.tsx — Memory tab content for the viewer.
 *
 * Left column: 4-scope filter + entry list (subscribes to memory.updated
 * for live refresh). Right column: Monaco markdown editor for the
 * selected entry + save / delete / reveal actions.
 */

import Editor from '@monaco-editor/react';
import { FolderOpen, Loader2, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from '../../locales';
import { agentClient } from '../../services/agent/AgentClientService';

type MemoryScope = 'user' | 'feedback' | 'project' | 'reference';

interface MemoryEntry {
  scope: MemoryScope;
  name: string;
  last_modified: string;
  preview: string;
}

interface MemoryDetail {
  scope: MemoryScope;
  name: string;
  content: string;
  last_modified: string;
}

const SCOPES: MemoryScope[] = ['user', 'feedback', 'project', 'reference'];
const NAME_PATTERN = /^[a-z0-9_-]{1,64}$/;

export const MemoryPane: React.FC = () => {
  const { t } = useTranslation();
  const [scope, setScope] = useState<MemoryScope>('user');
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [selected, setSelected] = useState<{ scope: MemoryScope; name: string } | null>(null);
  const [detail, setDetail] = useState<MemoryDetail | null>(null);
  const [draftContent, setDraftContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');

  const filteredEntries = useMemo(
    () => entries.filter((e) => e.scope === scope),
    [entries, scope]
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await agentClient.memoryList();
      setEntries(res.entries ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (s: MemoryScope, name: string) => {
    try {
      const res = await agentClient.memoryGet(s, name);
      setDetail(res);
      setDraftContent(res.content);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live refresh on memory.updated — engine extractor writes flow here too.
  useEffect(() => {
    const off = agentClient.onMemoryUpdated((evt: { scope: MemoryScope; name: string }) => {
      void refresh();
      if (selected && selected.scope === evt.scope && selected.name === evt.name) {
        void loadDetail(evt.scope, evt.name);
      }
    });
    return off;
  }, [refresh, selected, loadDetail]);

  const onSelect = useCallback(
    (entry: MemoryEntry) => {
      setSelected({ scope: entry.scope, name: entry.name });
      void loadDetail(entry.scope, entry.name);
    },
    [loadDetail]
  );

  const onSave = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await agentClient.memoryWrite(selected.scope, selected.name, draftContent);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [selected, draftContent]);

  const onDelete = useCallback(async () => {
    if (!selected) return;
    if (!window.confirm(t('memoryViewer.deleteConfirm', { name: selected.name }))) return;
    try {
      await agentClient.memoryDelete(selected.scope, selected.name);
      setSelected(null);
      setDetail(null);
      setDraftContent('');
    } catch (err) {
      setError((err as Error).message);
    }
  }, [selected, t]);

  const onCreate = useCallback(async () => {
    if (!NAME_PATTERN.test(newName)) {
      setError(t('memoryViewer.newEntryInvalid'));
      return;
    }
    try {
      await agentClient.memoryWrite(scope, newName, `# ${newName}\n\n`);
      setShowNew(false);
      const created = newName;
      setNewName('');
      setSelected({ scope, name: created });
      void loadDetail(scope, created);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [newName, scope, loadDetail, t]);

  const onReveal = useCallback(() => {
    void agentClient.memoryReveal(selected?.scope, selected?.name);
  }, [selected]);

  const isNoSession = error?.includes('No active SNACA session');

  return (
    <div className="flex h-full">
      <aside
        className="flex w-72 shrink-0 flex-col border-r"
        style={{ borderRightColor: 'var(--color-border)' }}
      >
        <div
          className="flex shrink-0 gap-1 border-b p-2"
          style={{ borderBottomColor: 'var(--color-border)' }}
        >
          {SCOPES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={`flex-1 rounded px-2 py-1 text-xs ${
                scope === s
                  ? 'bg-[var(--color-accent)] text-white'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'
              }`}
            >
              {t(`memoryViewer.scope.${s}` as const)}
            </button>
          ))}
        </div>

        <div className="flex shrink-0 gap-2 p-2">
          <button
            type="button"
            onClick={() => setShowNew(true)}
            className="inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-bg-hover)]"
          >
            <Plus size={12} /> {t('memoryViewer.newEntry')}
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            className="inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-bg-hover)]"
            title={t('memoryViewer.reload')}
          >
            <RefreshCw size={12} />
          </button>
          <button
            type="button"
            onClick={onReveal}
            className="inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-bg-hover)]"
            title={t('memoryViewer.reveal')}
          >
            <FolderOpen size={12} />
          </button>
        </div>

        {showNew && (
          <div className="shrink-0 border-b border-[var(--color-border)] p-2">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value.toLowerCase())}
              placeholder={t('memoryViewer.newEntryNamePlaceholder')}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void onCreate();
                if (e.key === 'Escape') {
                  setShowNew(false);
                  setNewName('');
                }
              }}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1 text-xs"
            />
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-4 text-xs text-[var(--color-text-muted)]">
              <Loader2 size={14} className="animate-spin" />
            </div>
          )}
          {!loading && filteredEntries.length === 0 && (
            <div className="px-3 py-4 text-xs text-[var(--color-text-muted)]">
              {isNoSession ? t('memoryViewer.noActiveSession') : t('memoryViewer.empty')}
            </div>
          )}
          {filteredEntries.map((entry) => (
            <button
              key={`${entry.scope}/${entry.name}`}
              type="button"
              onClick={() => onSelect(entry)}
              className={`block w-full border-l-2 px-3 py-2 text-left text-xs ${
                selected?.scope === entry.scope && selected?.name === entry.name
                  ? 'border-l-[var(--color-accent)] bg-[var(--color-bg-tertiary)]'
                  : 'border-l-transparent hover:bg-[var(--color-bg-hover)]'
              }`}
            >
              <div className="font-medium">{entry.name}</div>
              <div className="mt-0.5 truncate text-[var(--color-text-muted)]">
                {entry.preview || t('memoryViewer.noPreview')}
              </div>
            </button>
          ))}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center text-sm text-[var(--color-text-muted)]">
            {t('memoryViewer.previewPlaceholder')}
          </div>
        ) : (
          <>
            <div
              className="flex shrink-0 items-center gap-2 border-b px-4 py-2"
              style={{ borderBottomColor: 'var(--color-border)' }}
            >
              <div className="flex-1">
                <div className="text-sm font-semibold">{selected.name}</div>
                <div className="text-[11px] text-[var(--color-text-muted)]">
                  {t(`memoryViewer.scope.${selected.scope}` as const)}
                  {detail?.last_modified ? ` · ${detail.last_modified}` : ''}
                </div>
              </div>
              <button
                type="button"
                onClick={onSave}
                disabled={saving || draftContent === (detail?.content ?? '')}
                className="inline-flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1 text-xs hover:bg-[var(--color-bg-tertiary)] disabled:opacity-40"
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                {saving ? t('memoryViewer.saving') : t('memoryViewer.save')}
              </button>
              <button
                type="button"
                onClick={onDelete}
                className="inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs text-red-400 hover:bg-[var(--color-bg-tertiary)]"
              >
                <Trash2 size={12} />
                {t('memoryViewer.delete')}
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <Editor
                value={draftContent}
                language="markdown"
                onChange={(v) => setDraftContent(v ?? '')}
                theme="vs-dark"
                options={{
                  minimap: { enabled: false },
                  wordWrap: 'on',
                  fontSize: 13,
                  scrollBeyondLastLine: false,
                }}
              />
            </div>
          </>
        )}
        {error && !isNoSession && (
          <div className="shrink-0 border-t border-red-700/50 bg-red-900/20 px-4 py-2 text-xs text-red-300">
            {error}
          </div>
        )}
      </section>
    </div>
  );
};
