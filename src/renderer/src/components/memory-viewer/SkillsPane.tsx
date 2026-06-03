/**
 * @file SkillsPane.tsx — Skills tab content for the viewer (read-only).
 *
 * Left column: skill list with scope chip + description preview.
 * Right column: frontmatter table + raw body in a preformatted block.
 * Skills are .md files maintained by developers in their editor; this
 * pane just lets users verify what got loaded into the engine.
 */

import { FolderOpen, Loader2, RefreshCw } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { useTranslation } from '../../locales';
import { agentClient } from '../../services/agent/AgentClientService';

type SkillScope = 'bundled' | 'tenant' | 'project';

interface SkillSummary {
  scope: SkillScope;
  name: string;
  description?: string;
  when_to_use?: string;
  allowed_tools: string[];
  source_path: string;
}

interface SkillDetail extends SkillSummary {
  body: string;
}

export const SkillsPane: React.FC = () => {
  const { t } = useTranslation();
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await agentClient.skillsList();
      setSkills(res.skills ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSelect = useCallback(async (name: string) => {
    setSelected(name);
    try {
      const res = await agentClient.skillsGet(name);
      setDetail(res.skill);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const onReload = useCallback(async () => {
    await agentClient.skillsReload();
    await refresh();
    if (selected) {
      await onSelect(selected);
    }
  }, [refresh, selected, onSelect]);

  const onReveal = useCallback(() => {
    if (!detail?.source_path) return;
    // Skills don't go through memory.reveal — the source_path is a
    // direct OS path. openExternal with `file://` works on Win + mac +
    // Linux and avoids a dedicated skills.reveal RPC (skills.* is
    // read-only by design).
    void api.app.openExternal(`file://${detail.source_path}`);
  }, [detail]);

  const isNoSession = error?.includes('No active SNACA session');

  return (
    <div className="flex h-full">
      <aside
        className="flex w-72 shrink-0 flex-col border-r"
        style={{ borderRightColor: 'var(--color-border)' }}
      >
        <div className="flex shrink-0 gap-2 p-2">
          <button
            type="button"
            onClick={() => void onReload()}
            className="inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-bg-hover)]"
          >
            <RefreshCw size={12} />
            {t('memoryViewer.reload')}
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-4">
              <Loader2 size={14} className="animate-spin" />
            </div>
          )}
          {!loading && skills.length === 0 && (
            <div className="px-3 py-4 text-xs text-[var(--color-text-muted)]">
              {isNoSession ? t('memoryViewer.noActiveSession') : t('memoryViewer.emptySkills')}
            </div>
          )}
          {skills.map((s) => (
            <button
              key={`${s.scope}/${s.name}`}
              type="button"
              onClick={() => void onSelect(s.name)}
              className={`block w-full border-l-2 px-3 py-2 text-left text-xs ${
                selected === s.name
                  ? 'border-l-[var(--color-accent)] bg-[var(--color-bg-tertiary)]'
                  : 'border-l-transparent hover:bg-[var(--color-bg-hover)]'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">{s.name}</span>
                <span className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
                  {t(`memoryViewer.skillScope.${s.scope}` as const)}
                </span>
              </div>
              {s.description && (
                <div className="mt-0.5 truncate text-[var(--color-text-muted)]">
                  {s.description}
                </div>
              )}
            </button>
          ))}
        </div>
      </aside>

      <section className="min-w-0 flex-1 overflow-y-auto px-6 py-4">
        {!detail ? (
          <div className="text-sm text-[var(--color-text-muted)]">
            {t('memoryViewer.previewPlaceholder')}
          </div>
        ) : (
          <>
            <div className="mb-4 flex items-center gap-3">
              <h2 className="text-lg font-semibold">{detail.name}</h2>
              <span className="rounded bg-[var(--color-bg-tertiary)] px-2 py-0.5 text-xs text-[var(--color-text-muted)]">
                {t(`memoryViewer.skillScope.${detail.scope}` as const)}
              </span>
              {detail.source_path && (
                <button
                  type="button"
                  onClick={onReveal}
                  className="ml-auto inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-bg-hover)]"
                  title={t('memoryViewer.reveal')}
                >
                  <FolderOpen size={12} />
                </button>
              )}
            </div>

            <dl className="mb-6 space-y-2 text-sm">
              {detail.description && (
                <SkillField label={t('memoryViewer.fieldDescription')} value={detail.description} />
              )}
              {detail.when_to_use && (
                <SkillField label={t('memoryViewer.fieldWhenToUse')} value={detail.when_to_use} />
              )}
              {detail.allowed_tools.length > 0 && (
                <SkillField
                  label={t('memoryViewer.fieldAllowedTools')}
                  value={detail.allowed_tools.join(', ')}
                />
              )}
              {detail.source_path && (
                <SkillField
                  label={t('memoryViewer.fieldSourcePath')}
                  value={detail.source_path}
                  mono
                />
              )}
            </dl>

            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              {t('memoryViewer.body')}
            </h3>
            <pre className="whitespace-pre-wrap rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3 text-xs leading-relaxed">
              {detail.body}
            </pre>
          </>
        )}
        {error && !isNoSession && (
          <div className="mt-4 border-t border-red-700/50 bg-red-900/20 px-4 py-2 text-xs text-red-300">
            {error}
          </div>
        )}
      </section>
    </div>
  );
};

const SkillField: React.FC<{ label: string; value: string; mono?: boolean }> = ({
  label,
  value,
  mono,
}) => (
  <div className="flex gap-3">
    <dt className="w-32 shrink-0 text-xs text-[var(--color-text-muted)]">{label}</dt>
    <dd className={`flex-1 text-xs ${mono ? 'font-mono break-all' : ''}`}>{value}</dd>
  </div>
);
