/**
 * @file TemplatePickerDialog.tsx — "New from template" flow.
 *
 * Facing a blank `main.tex` is where first-time users stall, so the welcome
 * screen offers scaffolds. This dialog picks the template and names the
 * folder; the main process then prompts for the parent directory (it owns
 * the write authorization) and copies the files.
 *
 * The template list comes from the bundled manifest — display text is keyed
 * off the template id (`templates.<id>.name`), so main never ships strings.
 */

import { Check, FileText, Loader2, WifiOff } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { ProjectTemplateDTO } from '../../../../../shared/ipc/file-contract';
import { api } from '../../api';
import { useTranslation, type TranslationKey } from '../../locales';
import { Modal } from '../ui';

export interface TemplatePickerDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * Called once the project exists on disk. The file tree is handed over
   * rather than re-read: the main handler already built it while setting up
   * the watcher and path sandbox.
   */
  onCreated: (result: {
    projectPath: string;
    mainFile: string;
    fileTree: ProjectCreateFromTemplateSuccess['fileTree'];
  }) => void;
}

/** Narrow the success arm so the callback type stays readable. */
type ProjectCreateFromTemplateSuccess = Extract<
  Awaited<ReturnType<typeof api.project.createFromTemplate>>,
  { ok: true }
>;

/** Default folder name, kept filesystem-safe and obviously replaceable. */
const DEFAULT_PROJECT_NAME = 'my-paper';

export const TemplatePickerDialog: React.FC<TemplatePickerDialogProps> = ({
  open,
  onClose,
  onCreated,
}) => {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<ProjectTemplateDTO[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState(DEFAULT_PROJECT_NAME);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load on open rather than mount: the list is tiny, and re-reading means a
  // user who installs an update mid-session sees new templates.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    void api.project
      .listTemplates()
      .then((list) => {
        if (cancelled) return;
        setTemplates(list);
        setSelectedId((current) => current ?? list[0]?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleCreate = useCallback(async () => {
    if (!selectedId || !projectName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const result = await api.project.createFromTemplate(selectedId, projectName.trim());
      if (result.ok) {
        onCreated({
          projectPath: result.projectPath,
          mainFile: result.mainFile,
          fileTree: result.fileTree,
        });
        onClose();
        return;
      }
      // Dismissing the directory picker is a normal way to back out — no
      // error, just return to the dialog.
      if (!result.cancelled) {
        setError(t('templates.createFailed', { error: result.error }));
      }
    } catch (err) {
      setError(
        t('templates.createFailed', {
          error: err instanceof Error ? err.message : String(err),
        })
      );
    } finally {
      setCreating(false);
    }
  }, [selectedId, projectName, onCreated, onClose, t]);

  return (
    <Modal
      open={open}
      onClose={creating ? () => undefined : onClose}
      title={t('templates.dialogTitle')}
      description={t('templates.dialogDesc')}
      size="lg"
    >
      <div className="flex flex-col gap-4">
        {templates === null ? (
          <div className="flex items-center justify-center py-8 text-[var(--color-text-muted)]">
            <Loader2 size={18} className="animate-spin" aria-hidden="true" />
          </div>
        ) : templates.length === 0 ? (
          <p className="py-6 text-center text-sm text-[var(--color-text-muted)]">
            {t('templates.empty')}
          </p>
        ) : (
          <div
            className="grid grid-cols-2 gap-2"
            role="radiogroup"
            aria-label={t('templates.dialogTitle')}
          >
            {templates.map((template) => {
              const selected = template.id === selectedId;
              return (
                <button
                  key={template.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setSelectedId(template.id)}
                  className="cursor-pointer rounded-xl border p-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                  style={{
                    borderColor: selected ? 'var(--color-accent)' : 'var(--color-border)',
                    background: selected ? 'var(--color-accent-muted)' : 'var(--color-bg-elevated)',
                  }}
                >
                  <div className="mb-1 flex items-center gap-2">
                    <FileText
                      size={14}
                      aria-hidden="true"
                      style={{
                        color: selected ? 'var(--color-accent)' : 'var(--color-text-muted)',
                      }}
                    />
                    <span className="text-sm font-medium text-[var(--color-text-primary)]">
                      {t(`templates.${template.id}.name` as TranslationKey)}
                    </span>
                    {selected && (
                      <Check
                        size={13}
                        className="ml-auto text-[var(--color-accent)]"
                        aria-hidden="true"
                      />
                    )}
                  </div>
                  <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">
                    {t(`templates.${template.id}.description` as TranslationKey)}
                  </p>
                  {/* Offline capability is the promise that distinguishes a
                      bundled template from a downloaded one — surface it. */}
                  <p className="mt-1.5 flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
                    <WifiOff size={10} aria-hidden="true" />
                    {template.offline ? t('templates.offlineReady') : t('templates.needsNetwork')}
                  </p>
                </button>
              );
            })}
          </div>
        )}

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-[var(--color-text-secondary)]">
            {t('templates.projectName')}
          </span>
          <input
            type="text"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder={t('templates.projectNamePlaceholder')}
            disabled={creating}
            className="rounded-lg border px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:opacity-60"
            style={{
              borderColor: 'var(--color-border)',
              background: 'var(--color-bg-primary)',
              color: 'var(--color-text-primary)',
            }}
          />
        </label>

        {error && (
          <p role="alert" className="text-xs text-[var(--color-error)]">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={creating}
            className="cursor-pointer rounded-lg border px-3 py-1.5 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
            style={{ borderColor: 'var(--color-border)' }}
          >
            {t('templates.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={creating || !selectedId || !projectName.trim()}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
            style={{ background: 'var(--color-accent)' }}
          >
            {creating && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
            {creating ? t('templates.creating') : t('templates.create')}
          </button>
        </div>
      </div>
    </Modal>
  );
};
