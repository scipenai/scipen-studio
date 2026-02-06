/**
 * @file FileConflictModal.tsx - File Conflict Modal
 * @description Handles external file modification or deletion conflicts, provides user resolution options
 */

import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, RefreshCw, Save, Trash2, X } from 'lucide-react';
import type React from 'react';
import { api } from '../api';
import { useTranslation } from '../locales';
import { getEditorService, getProjectService, useFileConflict } from '../services/core';

export const FileConflictModal: React.FC = () => {
  const fileConflict = useFileConflict();
  const { t } = useTranslation();

  const resolveFileConflict = async (action: 'reload' | 'overwrite' | 'close') => {
    if (!fileConflict) return;

    const projectService = getProjectService();
    const editorService = getEditorService();
    const { path } = fileConflict;

    try {
      if (action === 'reload') {
        // Reload file content from external source and mark as clean
        const result = await api.file.read(path);
        if (result !== undefined) {
          // setContentFromExternal marks as clean and updates WorkingCopy
          editorService.setContentFromExternal(path, result.content);
          editorService.updateFileMtime(path, result.mtime);
        }
      } else if (action === 'overwrite') {
        // Keep user changes and save to file (transactional save)
        const saveInfo = editorService.beginSave(path);
        if (saveInfo) {
          const result = await api.file.write(path, saveInfo.content);
          // Update mtime and complete save
          if (result?.currentMtime) {
            editorService.updateFileMtime(path, result.currentMtime);
          }
          editorService.completeSave(path, saveInfo.version);
        }
      } else if (action === 'close') {
        editorService.closeTab(path);
      }
    } catch (error) {
      console.error('Failed to resolve file conflict:', error);
    } finally {
      projectService.clearFileConflict();
    }
  };

  if (!fileConflict) return null;

  const { path, type, hasUnsavedChanges } = fileConflict;
  const fileName = path.split(/[/\\]/).pop() || path;

  const isDeleted = type === 'unlink';

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
        onClick={() => resolveFileConflict('close')}
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.95, opacity: 0 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg shadow-2xl w-[480px] max-w-[90vw] overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--color-border)] bg-[var(--color-bg-primary)]">
            <div
              className={`p-2 rounded-full ${isDeleted ? 'bg-[var(--color-error-muted)]' : 'bg-[var(--color-warning-muted)]'}`}
            >
              {isDeleted ? (
                <Trash2 size={20} className="text-[var(--color-error)]" />
              ) : (
                <AlertTriangle size={20} className="text-[var(--color-warning)]" />
              )}
            </div>
            <div>
              <h3 className="text-base font-medium text-[var(--color-text-primary)]">
                {isDeleted ? t('fileConflict.fileDeleted') : t('fileConflict.fileModified')}
              </h3>
              <p
                className="text-sm text-[var(--color-text-muted)] mt-0.5 truncate max-w-[350px]"
                title={path}
              >
                {fileName}
              </p>
            </div>
          </div>

          <div className="px-5 py-4">
            {isDeleted ? (
              <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">
                {t('fileConflict.deletedDesc')}
                {hasUnsavedChanges && (
                  <span className="text-[var(--color-warning)]">
                    {' '}
                    {t('fileConflict.unsavedChanges')}
                  </span>
                )}
              </p>
            ) : (
              <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">
                {t('fileConflict.modifiedDesc')}
                {hasUnsavedChanges ? (
                  <span className="text-[var(--color-warning)]">
                    {' '}
                    {t('fileConflict.unsavedWillLose')}
                  </span>
                ) : (
                  <span> {t('fileConflict.reloadQuestion')}</span>
                )}
              </p>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-[var(--color-border)] bg-[var(--color-bg-primary)]/50">
            {isDeleted ? (
              <>
                {hasUnsavedChanges && (
                  <button
                    onClick={() => resolveFileConflict('overwrite')}
                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-[var(--color-accent)] hover:brightness-110 rounded-md transition-all"
                  >
                    <Save size={16} />
                    {t('fileConflict.saveAs')}
                  </button>
                )}
                <button
                  onClick={() => resolveFileConflict('close')}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-[var(--color-text-secondary)] bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-hover)] rounded-md transition-colors"
                >
                  <X size={16} />
                  {t('fileConflict.closeFile')}
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => resolveFileConflict('close')}
                  className="px-4 py-2 text-sm font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
                >
                  {t('common.cancel')}
                </button>
                {hasUnsavedChanges && (
                  <button
                    onClick={() => resolveFileConflict('overwrite')}
                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-[var(--color-text-primary)] bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-hover)] rounded-md transition-colors"
                  >
                    <Save size={16} />
                    {t('fileConflict.keepMyChanges')}
                  </button>
                )}
                <button
                  onClick={() => resolveFileConflict('reload')}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-[var(--color-accent)] hover:brightness-110 rounded-md transition-all"
                >
                  <RefreshCw size={16} />
                  {t('fileConflict.reload')}
                </button>
              </>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};
