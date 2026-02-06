/**
 * @file KnowledgePanel.tsx - Knowledge Base Management Panel
 * @description Manages multimodal knowledge base with document upload, indexing and retrieval
 * @depends api, services/core, @tanstack/react-virtual, framer-motion
 */

import { useVirtualizer } from '@tanstack/react-virtual';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  File,
  FileAudio,
  FileImage,
  FileText,
  FolderPlus,
  HardDrive,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
  XCircle,
} from 'lucide-react';
import type React from 'react';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useIpcEvent } from '../hooks';
import {
  getKnowledgeBaseService,
  getProjectService,
  useKnowledgeBases,
  useSelectedKnowledgeBaseId,
} from '../services/core';
import { useTranslation } from '../locales';
import { formatDate, formatFileSize } from '../utils';

// ====== Performance Optimization Utility Functions ======

/**
 * Create a non-blocking setter (defers state updates to idle time)
 * Only used for non-critical UI updates like background task progress
 */
function createDeferredSetter<T>(
  setter: React.Dispatch<React.SetStateAction<T>>
): React.Dispatch<React.SetStateAction<T>> {
  return (value: React.SetStateAction<T>) => {
    // Use requestAnimationFrame to defer updates, more reliable than requestIdleCallback
    // Background task progress doesn't need immediate response, using RAF ensures it doesn't block critical interactions
    requestAnimationFrame(() => setter(value));
  };
}

// Background task type (upload/delete etc.)
interface BackgroundTask {
  id: string;
  filename: string; // For delete tasks, this is the knowledge base name
  libraryId: string;
  progress: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  message?: string;
  type: 'upload' | 'delete'; // Task type
}

// Document info interface
interface DocumentInfo {
  id: string;
  filename: string;
  filePath: string;
  mediaType: string;
  fileSize: number;
  processStatus: string;
  createdAt: string; // ISO 8601 string from DTO
  metadata?: {
    title?: string;
    abstract?: string;
    authors?: string[];
    keywords?: string[];
  };
}

export const KnowledgePanel: React.FC = () => {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');
  // Use useDeferredValue to defer search query updates, avoid lag during input
  const deferredSearchQuery = useDeferredValue(searchQuery);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [expandedKbId, setExpandedKbId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [docContextMenu, setDocContextMenu] = useState<{
    x: number;
    y: number;
    doc: DocumentInfo;
  } | null>(null);

  // Background task state (upload, delete etc.)
  const [activeTasks, setActiveTasks] = useState<BackgroundTask[]>([]);
  const [showTaskProgress, setShowTaskProgress] = useState(false);

  // Busy state - show overlay
  const [busyState, setBusyState] = useState<{ isBusy: boolean; message: string }>({
    isBusy: false,
    message: '',
  });

  // Panel container ref - used to restore focus after deletion
  const panelRef = useRef<HTMLDivElement>(null);

  // Global context menu close (click anywhere or press Esc)
  useEffect(() => {
    if (!docContextMenu) return;

    const handleClick = () => setDocContextMenu(null);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDocContextMenu(null);
    };

    window.addEventListener('click', handleClick);
    window.addEventListener('contextmenu', handleClick);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('click', handleClick);
      window.removeEventListener('contextmenu', handleClick);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [docContextMenu]);

  // Fine-grained subscription - using new service architecture
  const knowledgeBases = useKnowledgeBases();
  const selectedKnowledgeBaseId = useSelectedKnowledgeBaseId();
  const projectService = getProjectService();

  // Note: Removed overly aggressive deferredSetDocuments optimization
  // Knowledge base document list needs immediate response to user clicks, cannot be deferred
  // Only keep deferred update for activeTasks (background task progress doesn't need immediate response)
  const deferredSetActiveTasks = useMemo(() => createDeferredSetter(setActiveTasks), []);

  // Check if there are active tasks
  const hasActiveTasks = useMemo(
    () => activeTasks.some((t) => t.status === 'pending' || t.status === 'processing'),
    [activeTasks]
  );

  const loadKnowledgeBases = useCallback(async () => {
    setIsLoading(true);
    try {
      const kbService = getKnowledgeBaseService();
      const libs = await kbService.loadLibraries();
      if (libs) {
        projectService.setKnowledgeBases(libs);
      }
    } catch (error) {
      console.error('[KnowledgePanel] Failed to load knowledge base list:', error);
    } finally {
      setIsLoading(false);
    }
  }, [projectService]);

  // Listen to document changes for auto-refresh
  useEffect(() => {
    const dispose = getKnowledgeBaseService().onDocumentsChanged(({ libraryId, documents }) => {
      // Only update if it's the currently expanded knowledge base
      if (libraryId === expandedKbId) {
        setDocuments(documents);
      }
    });
    return () => dispose.dispose();
  }, [expandedKbId]);

  const loadDocuments = useCallback(async (libraryId: string) => {
    setLoadingDocs(true);
    try {
      const documents = await getKnowledgeBaseService().loadDocuments(libraryId);
      if (documents) {
        setDocuments(documents);
      } else {
        setDocuments([]);
      }
    } catch (error) {
      console.error('[KnowledgePanel] Failed to load document list:', error);
      setDocuments([]);
    } finally {
      setLoadingDocs(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    loadKnowledgeBases();
  }, [loadKnowledgeBases]);

  // Listen to backend task progress events (upload, delete etc.)
  // Use useIpcEvent to automatically manage IPC event subscriptions
  useIpcEvent(
    api.knowledge.onTaskProgress,
    (event: {
      taskId: string;
      progress: number;
      status: string;
      message?: string;
      filename?: string;
      taskType?: 'upload' | 'delete';
    }) => {
      // Check if it's a new delete task
      const isNewDeleteTask = event.taskType === 'delete';

      // When task completes or fails, update state immediately (no delay) to ensure user sees correct final state
      const isTerminalState = event.status === 'completed' || event.status === 'failed';
      const updateFn = isTerminalState ? setActiveTasks : deferredSetActiveTasks;

      updateFn((prev) => {
        const existing = prev.find((t) => t.id === event.taskId);
        if (existing) {
          return prev.map((t) =>
            t.id === event.taskId
              ? {
                  ...t,
                  progress: event.progress,
                  status: event.status as BackgroundTask['status'],
                  message: event.message,
                }
              : t
          );
        } else if (isNewDeleteTask) {
          // New delete task - automatically add to list
          return [
            ...prev,
            {
              id: event.taskId,
              filename: event.filename || 'Knowledge Base',
              libraryId: event.taskId.replace('delete-', ''),
              progress: event.progress,
              status: event.status as BackgroundTask['status'],
              message: event.message,
              type: 'delete',
            },
          ];
        }
        return prev;
      });

      // If it's a new delete task, show progress panel (this is UI feedback, needs immediate update)
      if (isNewDeleteTask) {
        setShowTaskProgress(true);
      }

      // When task completes, only upload tasks need to refresh list (delete tasks handled via optimistic update)
      if (event.status === 'completed' && event.taskType === 'upload') {
        // Directly refresh knowledge base list, don't use scheduleIdleCallback (avoid delay)
        loadKnowledgeBases();
      }
      // On failure, directly refresh document list (user needs to see real state immediately)
      if (event.status === 'failed') {
        const libraryId = selectedKnowledgeBaseId;
        if (libraryId) {
          loadDocuments(libraryId);
        }
      }
    }
  );

  // Expand/collapse knowledge base
  const handleToggleExpand = async (kbId: string) => {
    if (expandedKbId === kbId) {
      setExpandedKbId(null);
      setDocuments([]);
    } else {
      setExpandedKbId(kbId);
      await loadDocuments(kbId);
    }
  };

  const handleDeleteDocument = useCallback(
    async (docId: string, libraryId: string) => {
      const kbService = getKnowledgeBaseService();
      const result = await kbService.deleteDocument(docId, libraryId);

      if (!result.success && result.error === 'User cancelled') return;

      // Optimistic update
      setDocuments((prev) => prev.filter((d) => d.id !== docId));
      setSelectedDocId(null);

      if (result.success) {
        setTimeout(() => {
          const currentKbs = getProjectService().knowledgeBases;
          const updatedKbs = currentKbs.map((kb) =>
            kb.id === libraryId
              ? { ...kb, documentCount: Math.max(0, (kb.documentCount || 1) - 1) }
              : kb
          );
          getProjectService().setKnowledgeBases(updatedKbs);
        }, 100);
      } else if (result.error) {
        console.error('[KnowledgePanel] Failed to delete document:', result.error);
        loadDocuments(libraryId);
      }
    },
    [loadDocuments]
  );

  const handleDocContextMenu = useCallback((e: React.MouseEvent, doc: DocumentInfo) => {
    e.preventDefault();
    e.stopPropagation();
    setDocContextMenu({ x: e.clientX, y: e.clientY, doc });
  }, []);

  const handleOpenDoc = useCallback(async (doc: DocumentInfo) => {
    try {
      if (!doc.filePath) return;
      await api.file.openPath(doc.filePath);
    } catch (error) {
      console.error('[KnowledgePanel] Failed to open file:', error);
    } finally {
      setDocContextMenu(null);
    }
  }, []);

  const handleShowDocInFolder = useCallback(async (doc: DocumentInfo) => {
    try {
      if (!doc.filePath) return;
      await api.file.showInFolder(doc.filePath);
    } catch (error) {
      console.error('[KnowledgePanel] Failed to show in folder:', error);
    } finally {
      setDocContextMenu(null);
    }
  }, []);

  const getFileIcon = (mediaType: string) => {
    switch (mediaType) {
      case 'pdf':
        return <FileText size={14} className="text-[var(--color-error)]" />;
      case 'image':
        return <FileImage size={14} className="text-[var(--color-success)]" />;
      case 'audio':
        return <FileAudio size={14} className="text-purple-400" />;
      default:
        return <File size={14} className="text-[var(--color-text-muted)]" />;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'completed':
        return (
          <span className="px-1.5 py-0.5 text-xs bg-[var(--color-success-muted)] text-[var(--color-success)] rounded">
            {t('knowledgePanel.processed')}
          </span>
        );
      case 'processing':
        return (
          <span className="px-1.5 py-0.5 text-xs bg-[var(--color-warning-muted)] text-[var(--color-warning)] rounded">
            {t('knowledgePanel.processing')}
          </span>
        );
      case 'failed':
        return (
          <span className="px-1.5 py-0.5 text-xs bg-[var(--color-error-muted)] text-[var(--color-error)] rounded">
            {t('knowledgePanel.failed')}
          </span>
        );
      default:
        return (
          <span className="px-1.5 py-0.5 text-xs bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] rounded">
            {t('knowledgePanel.pending')}
          </span>
        );
    }
  };

  const handleCreateKnowledgeBase = async (name: string, description: string) => {
    setShowCreateModal(false);
    setBusyState({ isBusy: true, message: 'Creating knowledge base...' });

    try {
      const result = await getKnowledgeBaseService().createLibrary(name, description);

      if (result.success && result.data) {
        const newKb = result.data;
        projectService.setKnowledgeBases([...knowledgeBases, newKb]);
        projectService.setSelectedKnowledgeBase(newKb.id);
      } else {
        throw new Error(result.error || 'Creation failed');
      }
    } catch (error) {
      console.error('Failed to create knowledge base:', error);
      alert('Failed to create knowledge base');
    } finally {
      setBusyState({ isBusy: false, message: '' });
    }
  };

  const handleDeleteKnowledgeBase = async (id: string) => {
    const currentKnowledgeBases = knowledgeBases;

    const result = await getKnowledgeBaseService().deleteLibrary(id);

    if (!result.success && result.error === 'User cancelled') return;

    // Optimistic update
    projectService.setKnowledgeBases(currentKnowledgeBases.filter((k) => k.id !== id));
    if (selectedKnowledgeBaseId === id) {
      projectService.setSelectedKnowledgeBase(null);
    }

    if (!result.success) {
      console.error('Failed to delete knowledge base:', result.error);
      await api.dialog.message('Failed to delete knowledge base, please retry', 'error');
      projectService.setKnowledgeBases(currentKnowledgeBases);
      loadKnowledgeBases();
      setBusyState({ isBusy: false, message: '' });
    }
  };

  // Select knowledge base
  const handleSelectKnowledgeBase = async (id: string) => {
    projectService.setSelectedKnowledgeBase(id);
  };

  // Clear completed tasks
  const clearCompletedTasks = useCallback(() => {
    setActiveTasks((prev) => prev.filter((t) => t.status !== 'completed' && t.status !== 'failed'));
  }, []);

  const handleUploadDocuments = useCallback(async () => {
    if (!selectedKnowledgeBaseId) {
      alert('Please select a knowledge base first');
      return;
    }

    const kbService = getKnowledgeBaseService();
    const result = await kbService.selectAndUploadFiles(selectedKnowledgeBaseId);

    if (result.success && result.data) {
      // Task has been created and dispatched via events, here just ensure panel is shown
      setShowTaskProgress(true);
      // Reload knowledge base list to update document count
      await loadKnowledgeBases();
    } else if (result.error && result.error !== 'User cancelled') {
      alert(`Upload failed: ${result.error}`);
    }
  }, [selectedKnowledgeBaseId, loadKnowledgeBases]);

  // Filter knowledge bases - use deferredSearchQuery to avoid lag during input
  const filteredKnowledgeBases = useMemo(() => {
    const query = deferredSearchQuery.toLowerCase();
    return knowledgeBases.filter((kb) => kb.name.toLowerCase().includes(query));
  }, [knowledgeBases, deferredSearchQuery]);

  return (
    <div ref={panelRef} tabIndex={-1} className="h-full flex flex-col relative outline-none">
      {/* Busy state overlay */}
      <AnimatePresence>
        {busyState.isBusy && <LoadingOverlay message={busyState.message} />}
      </AnimatePresence>

      {/* Search bar */}
      <div className="p-3" style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
        <div className="relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2"
            style={{ color: 'var(--color-text-muted)' }}
          />
          <input
            type="text"
            placeholder={t('knowledgeBase.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 rounded-lg text-sm focus:outline-none transition-colors"
            style={{
              background: 'var(--color-bg-tertiary)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-text-primary)',
            }}
          />
        </div>
      </div>

      {/* Toolbar */}
      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{ borderBottom: '1px solid var(--color-border-subtle)' }}
      >
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-1.5 px-2 py-1.5 text-xs rounded-md transition-colors cursor-pointer"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          <FolderPlus size={14} />
          <span>{t('knowledgePanel.new')}</span>
        </button>
        <button
          onClick={handleUploadDocuments}
          disabled={!selectedKnowledgeBaseId || hasActiveTasks}
          className="flex items-center gap-1.5 px-2 py-1.5 text-xs rounded-md transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          {hasActiveTasks ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          <span>{hasActiveTasks ? t('knowledgeBase.processing') : t('knowledgeBase.upload')}</span>
        </button>
        <button
          onClick={loadKnowledgeBases}
          disabled={isLoading}
          className="ml-auto p-1.5 rounded-md transition-colors cursor-pointer"
          style={{ color: 'var(--color-text-secondary)' }}
          title={t('knowledgeBase.refresh')}
        >
          <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Knowledge base list */}
      <div className="flex-1 overflow-y-auto">
        {filteredKnowledgeBases.length === 0 ? (
          <div
            className="h-full flex flex-col items-center justify-center px-6"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <Database size={48} className="mb-4 opacity-50" />
            <p className="text-sm text-center mb-4">{t('knowledgePanel.emptyTitle')}</p>
            <p className="text-xs text-center mb-4" style={{ color: 'var(--color-text-disabled)' }}>
              {t('knowledgePanel.emptyDesc')}
            </p>
            <button
              onClick={() => setShowCreateModal(true)}
              className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg transition-colors cursor-pointer"
              style={{
                background: 'var(--color-accent)',
                color: 'var(--color-bg-primary)',
              }}
            >
              <Plus size={16} />
              <span>{t('knowledgeBase.createKnowledgeBase')}</span>
            </button>
          </div>
        ) : (
          <div className="py-2">
            {filteredKnowledgeBases.map((kb) => (
              <div key={kb.id}>
                {/* Knowledge base item */}
                <div
                  className="group w-full p-3 flex items-start gap-3 text-left transition-colors cursor-pointer"
                  style={{
                    background:
                      selectedKnowledgeBaseId === kb.id
                        ? 'var(--color-accent-muted)'
                        : 'transparent',
                    borderLeft:
                      selectedKnowledgeBaseId === kb.id
                        ? '2px solid var(--color-accent)'
                        : '2px solid transparent',
                  }}
                  onClick={() => handleSelectKnowledgeBase(kb.id)}
                >
                  {/* Expand/collapse button */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleToggleExpand(kb.id);
                    }}
                    className="p-1 rounded transition-colors cursor-pointer"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    {expandedKbId === kb.id ? (
                      <ChevronDown size={14} />
                    ) : (
                      <ChevronRight size={14} />
                    )}
                  </button>

                  <div
                    className="p-2 rounded-lg"
                    style={{
                      background:
                        selectedKnowledgeBaseId === kb.id
                          ? 'var(--color-accent-muted)'
                          : 'var(--color-bg-tertiary)',
                    }}
                  >
                    <BookOpen
                      size={18}
                      style={{
                        color:
                          selectedKnowledgeBaseId === kb.id
                            ? 'var(--color-accent)'
                            : 'var(--color-text-muted)',
                      }}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3
                      className="text-sm font-medium truncate"
                      style={{ color: 'var(--color-text-primary)' }}
                    >
                      {kb.name}
                    </h3>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                      {t('knowledgeBase.documents')}: {kb.documentCount}
                    </p>
                    {kb.description && (
                      <p
                        className="text-xs mt-1 truncate"
                        style={{ color: 'var(--color-text-disabled)' }}
                      >
                        {kb.description}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteKnowledgeBase(kb.id);
                    }}
                    className="p-1 opacity-0 group-hover:opacity-100 rounded transition-all cursor-pointer"
                    style={{ color: 'var(--color-error)' }}
                    title={t('knowledgeBase.deleteKnowledgeBase')}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

                {/* Document list - use virtualization for performance */}
                <AnimatePresence>
                  {expandedKbId === kb.id && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="ml-6 border-l border-[var(--color-border)]"
                    >
                      {loadingDocs ? (
                        <div className="p-3 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                          <Loader2 size={12} className="animate-spin" />
                          <span>{t('knowledgePanel.loadingDocuments')}</span>
                        </div>
                      ) : (
                        <VirtualizedDocumentList
                          documents={documents}
                          selectedDocId={selectedDocId}
                          onSelectDoc={setSelectedDocId}
                          onDeleteDoc={handleDeleteDocument}
                          onContextMenuDoc={handleDocContextMenu}
                          libraryId={kb.id}
                          getFileIcon={getFileIcon}
                          getStatusBadge={getStatusBadge}
                        />
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Bottom info */}
      {selectedKnowledgeBaseId && (
        <div className="p-3 border-t border-[var(--color-border)]">
          <div className="flex items-center gap-2 text-xs text-[var(--color-success)]">
            <Check size={12} />
            <span>{t('knowledgePanel.ragSelected')}</span>
          </div>
        </div>
      )}

      {/* Document context menu */}
      {docContextMenu && (
        <div
          className="fixed z-50 min-w-[160px] bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg shadow-2xl overflow-hidden"
          style={{ top: docContextMenu.y, left: docContextMenu.x }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            className="w-full px-3 py-2 text-left text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors"
            onClick={() => handleOpenDoc(docContextMenu.doc)}
          >
            {t('common.open')}
          </button>
          <button
            className="w-full px-3 py-2 text-left text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors"
            onClick={() => handleShowDocInFolder(docContextMenu.doc)}
          >
            {t('fileExplorer.revealInExplorer')}
          </button>
        </div>
      )}

      {/* Task progress panel */}
      <AnimatePresence>
        {showTaskProgress && activeTasks.length > 0 && (
          <TaskProgressPanel
            tasks={activeTasks}
            onClose={() => setShowTaskProgress(false)}
            onClearCompleted={clearCompletedTasks}
          />
        )}
      </AnimatePresence>

      {/* Create knowledge base modal */}
      <AnimatePresence>
        {showCreateModal && (
          <CreateKnowledgeBaseModal
            onClose={() => setShowCreateModal(false)}
            onCreate={handleCreateKnowledgeBase}
          />
        )}
      </AnimatePresence>
    </div>
  );
};

// Task progress panel component (upload, delete etc.)
interface TaskProgressPanelProps {
  tasks: BackgroundTask[];
  onClose: () => void;
  onClearCompleted: () => void;
}

const TaskProgressPanel = memo<TaskProgressPanelProps>(({ tasks, onClose, onClearCompleted }) => {
  const { t } = useTranslation();
  const completedCount = tasks.filter((task) => task.status === 'completed').length;
  const failedCount = tasks.filter((task) => task.status === 'failed').length;
  const processingCount = tasks.filter(
    (task) => task.status === 'processing' || task.status === 'pending'
  ).length;

  // Determine main task type for displaying appropriate title
  const hasDeleteTasks = tasks.some((t) => t.type === 'delete');
  const hasUploadTasks = tasks.some((t) => t.type === 'upload');

  const getHeaderIcon = () => {
    if (hasDeleteTasks && !hasUploadTasks)
      return <Trash2 size={14} className="text-[var(--color-error)]" />;
    if (hasUploadTasks && !hasDeleteTasks)
      return <Upload size={14} className="text-[var(--color-accent)]" />;
    return <HardDrive size={14} className="text-[var(--color-accent)]" />;
  };

  const getHeaderTitle = () => {
    if (hasDeleteTasks && !hasUploadTasks) return t('knowledgeBase.deleteProgress');
    if (hasUploadTasks && !hasDeleteTasks) return t('knowledgeBase.uploadProgress');
    return t('knowledgeBase.taskProgress');
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      className="absolute bottom-16 left-2 right-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl shadow-2xl overflow-hidden z-50"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-tertiary)]/50">
        <div className="flex items-center gap-2">
          {getHeaderIcon()}
          <span className="text-sm font-medium text-[var(--color-text-primary)]">
            {getHeaderTitle()}
          </span>
          <span className="text-xs text-[var(--color-text-muted)]">
            {processingCount > 0 && t('knowledgePanel.processingCount', { count: processingCount })}
            {completedCount > 0 &&
              ` • ${t('knowledgePanel.completedCount', { count: completedCount })}`}
            {failedCount > 0 && ` • ${t('knowledgePanel.failedCount', { count: failedCount })}`}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {(completedCount > 0 || failedCount > 0) && (
            <button
              onClick={onClearCompleted}
              className="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] px-2 py-1 rounded hover:bg-[var(--color-bg-hover)] transition-colors"
            >
              {t('knowledgePanel.clearCompleted')}
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1 hover:bg-[var(--color-bg-hover)] rounded transition-colors"
          >
            <X size={14} className="text-[var(--color-text-muted)]" />
          </button>
        </div>
      </div>

      {/* Task list */}
      <div className="max-h-48 overflow-y-auto">
        {tasks.map((task) => (
          <div
            key={task.id}
            className="px-3 py-2 border-b border-[var(--color-border-subtle)] last:border-0"
          >
            <div className="flex items-center gap-2 mb-1">
              {/* Task type icon + status */}
              {task.type === 'delete' ? (
                task.status === 'processing' ? (
                  <Loader2 size={12} className="text-[var(--color-error)] animate-spin" />
                ) : task.status === 'pending' ? (
                  <Trash2 size={12} className="text-[var(--color-text-muted)]" />
                ) : task.status === 'completed' ? (
                  <Check size={12} className="text-[var(--color-success)]" />
                ) : (
                  <XCircle size={12} className="text-[var(--color-error)]" />
                )
              ) : // Upload tasks use blue theme
              task.status === 'processing' ? (
                <Loader2 size={12} className="text-[var(--color-warning)] animate-spin" />
              ) : task.status === 'pending' ? (
                <Clock size={12} className="text-[var(--color-text-muted)]" />
              ) : task.status === 'completed' ? (
                <Check size={12} className="text-[var(--color-success)]" />
              ) : (
                <XCircle size={12} className="text-[var(--color-error)]" />
              )}

              {/* Task name */}
              <span className="text-xs text-[var(--color-text-secondary)] truncate flex-1">
                {task.type === 'delete'
                  ? `${t('knowledgePanel.deletePrefix')}${task.filename}`
                  : task.filename}
              </span>

              {/* Progress percentage */}
              <span className="text-xs text-[var(--color-text-muted)]">{task.progress}%</span>
            </div>

            {/* Progress bar */}
            <div className="h-1 bg-[var(--color-bg-tertiary)] rounded-full overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${task.progress}%` }}
                className={`h-full rounded-full transition-all ${
                  task.status === 'failed'
                    ? 'bg-[var(--color-error)]'
                    : task.status === 'completed'
                      ? 'bg-[var(--color-success)]'
                      : task.type === 'delete'
                        ? 'bg-[var(--color-error)]'
                        : 'bg-[var(--color-accent)]'
                }`}
              />
            </div>

            {/* Status message */}
            {task.message && (
              <p
                className={`text-xs mt-1 ${
                  task.status === 'failed'
                    ? 'text-[var(--color-error)]'
                    : 'text-[var(--color-text-muted)]'
                }`}
              >
                {task.message}
              </p>
            )}
          </div>
        ))}
      </div>
    </motion.div>
  );
});

// Local loading overlay component
interface LoadingOverlayProps {
  message: string;
}

const LoadingOverlay: React.FC<LoadingOverlayProps> = ({ message }) => (
  <motion.div
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    exit={{ opacity: 0 }}
    transition={{ duration: 0.2 }}
    className="absolute inset-0 bg-[var(--color-bg-primary)]/60 backdrop-blur-sm z-50 flex flex-col items-center justify-center rounded-lg"
  >
    <motion.div
      initial={{ opacity: 0, scale: 0.95, y: 5 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95, y: 5 }}
      transition={{ duration: 0.2, type: 'spring', stiffness: 300, damping: 25 }}
      className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-5 pr-8 rounded-xl shadow-2xl flex items-center gap-4 min-w-[200px]"
    >
      <Loader2 className="w-5 h-5 text-[var(--color-accent)] animate-spin" />
      <div className="flex flex-col">
        <span className="text-sm font-medium text-[var(--color-text-primary)] tracking-wide">
          {message}
        </span>
        <span className="text-[10px] text-[var(--color-text-muted)] mt-0.5">Please wait...</span>
      </div>
    </motion.div>
  </motion.div>
);

// ====== Virtualized Document List Component ======
interface VirtualizedDocumentListProps {
  documents: DocumentInfo[];
  selectedDocId: string | null;
  onSelectDoc: (docId: string | null) => void;
  onDeleteDoc: (docId: string, libraryId: string) => void;
  onContextMenuDoc: (e: React.MouseEvent, doc: DocumentInfo) => void;
  libraryId: string;
  getFileIcon: (mediaType: string) => React.ReactNode;
  getStatusBadge: (status: string) => React.ReactNode;
}

const VirtualizedDocumentList = memo<VirtualizedDocumentListProps>(
  ({
    documents,
    selectedDocId,
    onSelectDoc,
    onDeleteDoc,
    onContextMenuDoc,
    libraryId,
    getFileIcon,
    getStatusBadge,
  }) => {
    const { t } = useTranslation();
    const parentRef = useRef<HTMLDivElement>(null);
    const [isMounted, setIsMounted] = useState(false);

    // Trigger re-render after DOM mount to ensure virtualizer can get scroll element
    useEffect(() => {
      setIsMounted(true);
    }, []);

    const virtualizer = useVirtualizer({
      count: documents.length,
      getScrollElement: () => parentRef.current,
      estimateSize: () => 36, // Fixed height to avoid calculation issues
      overscan: 5,
    });

    if (documents.length === 0) {
      return (
        <div className="p-3 text-xs text-[var(--color-text-muted)]">
          {t('knowledgePanel.noDocuments')}
        </div>
      );
    }

    // Use simple list when document count is low to avoid virtualization overhead
    // Or use simple list when DOM is not mounted
    const useSimpleList = documents.length <= 20 || !isMounted;

    const totalSize = virtualizer.getTotalSize();
    const virtualItems = virtualizer.getVirtualItems();

    // Fallback to simple list rendering if virtualization has issues or document count is low
    if (useSimpleList || totalSize === 0 || virtualItems.length === 0) {
      return (
        <div className="max-h-64 overflow-y-auto">
          {documents.map((doc) => {
            const isSelected = selectedDocId === doc.id;
            return (
              <div
                key={doc.id}
                className={`group/doc px-3 py-2 flex items-start gap-2 hover:bg-[var(--color-bg-hover)] cursor-pointer transition-colors ${
                  isSelected ? 'bg-[var(--color-bg-tertiary)]' : ''
                }`}
                onClick={() => onSelectDoc(isSelected ? null : doc.id)}
                onContextMenu={(e) => onContextMenuDoc(e, doc)}
              >
                {getFileIcon(doc.mediaType)}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-[var(--color-text-secondary)] truncate">
                      {doc.filename}
                    </span>
                    {getStatusBadge(doc.processStatus)}
                  </div>

                  {/* Expand to show detailed info */}
                  {isSelected && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      className="mt-2 space-y-1 text-xs"
                    >
                      <div className="flex items-center gap-2 text-[var(--color-text-muted)]">
                        <HardDrive size={10} />
                        <span>{formatFileSize(doc.fileSize)}</span>
                        <span>•</span>
                        <Clock size={10} />
                        <span>{formatDate(doc.createdAt)}</span>
                      </div>

                      {doc.metadata?.title && (
                        <div className="text-[var(--color-text-secondary)]">
                          <span className="text-[var(--color-text-muted)]">Title: </span>
                          {doc.metadata.title}
                        </div>
                      )}

                      {doc.metadata?.abstract && (
                        <div className="text-[var(--color-text-muted)] line-clamp-2">
                          <span className="text-[var(--color-text-disabled)]">Abstract: </span>
                          {doc.metadata.abstract.slice(0, 100)}...
                        </div>
                      )}

                      {doc.metadata?.authors && doc.metadata.authors.length > 0 && (
                        <div className="text-[var(--color-text-muted)]">
                          <span className="text-[var(--color-text-disabled)]">Authors: </span>
                          {doc.metadata.authors.join(', ')}
                        </div>
                      )}
                    </motion.div>
                  )}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteDoc(doc.id, libraryId);
                  }}
                  className="p-1 opacity-0 group-hover/doc:opacity-100 hover:bg-[var(--color-error-muted)] rounded transition-all"
                >
                  <Trash2 size={12} className="text-[var(--color-error)]" />
                </button>
              </div>
            );
          })}
        </div>
      );
    }

    return (
      <div ref={parentRef} className="max-h-64 overflow-y-auto">
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const doc = documents[virtualRow.index];
            const isSelected = selectedDocId === doc.id;

            return (
              <div
                key={doc.id}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <div
                  className={`group/doc px-3 py-2 flex items-start gap-2 hover:bg-[var(--color-bg-hover)] cursor-pointer transition-colors ${
                    isSelected ? 'bg-[var(--color-bg-tertiary)]' : ''
                  }`}
                  onClick={() => onSelectDoc(isSelected ? null : doc.id)}
                  onContextMenu={(e) => onContextMenuDoc(e, doc)}
                >
                  {getFileIcon(doc.mediaType)}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-[var(--color-text-secondary)] truncate">
                        {doc.filename}
                      </span>
                      {getStatusBadge(doc.processStatus)}
                    </div>

                    {/* Expand to show detailed info */}
                    {isSelected && (
                      <div className="mt-2 space-y-1 text-xs">
                        <div className="flex items-center gap-2 text-[var(--color-text-muted)]">
                          <HardDrive size={10} />
                          <span>{formatFileSize(doc.fileSize)}</span>
                          <span>•</span>
                          <Clock size={10} />
                          <span>{formatDate(doc.createdAt)}</span>
                        </div>

                        {doc.metadata?.title && (
                          <div className="text-[var(--color-text-secondary)]">
                            <span className="text-[var(--color-text-muted)]">Title: </span>
                            {doc.metadata.title}
                          </div>
                        )}

                        {doc.metadata?.abstract && (
                          <div className="text-[var(--color-text-muted)] line-clamp-2">
                            <span className="text-[var(--color-text-disabled)]">Abstract: </span>
                            {doc.metadata.abstract.slice(0, 100)}...
                          </div>
                        )}

                        {doc.metadata?.authors && doc.metadata.authors.length > 0 && (
                          <div className="text-[var(--color-text-muted)]">
                            <span className="text-[var(--color-text-disabled)]">Authors: </span>
                            {doc.metadata.authors.join(', ')}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Delete document button */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteDoc(doc.id, libraryId);
                    }}
                    className="p-1 opacity-0 group-hover/doc:opacity-100 hover:bg-[var(--color-error-muted)] rounded transition-all"
                    title="Delete document"
                  >
                    <Trash2 size={12} className="text-[var(--color-error)]" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }
);

interface CreateKnowledgeBaseModalProps {
  onClose: () => void;
  onCreate: (name: string, description: string) => void;
}

const CreateKnowledgeBaseModal: React.FC<CreateKnowledgeBaseModalProps> = ({
  onClose,
  onCreate,
}) => {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  // Focus input - use single requestAnimationFrame to avoid delay
  useEffect(() => {
    // Use requestAnimationFrame to ensure DOM is rendered
    const rafId = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });

    return () => cancelAnimationFrame(rafId);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      onCreate(name.trim(), description.trim());
    }
  };

  // Close on backdrop click
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[100]"
      onClick={handleBackdropClick}
    >
      <div
        ref={modalRef}
        className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-6 w-full max-w-md mx-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-medium text-[var(--color-text-primary)]">
            {t('knowledgePanel.createTitle')}
          </h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-[var(--color-bg-hover)] rounded-lg transition-colors"
          >
            <X size={20} className="text-[var(--color-text-muted)]" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-[var(--color-text-secondary)] mb-2">
              {t('knowledgePanel.nameLabel')}
            </label>
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onFocus={(e) => e.target.select()}
              placeholder={t('knowledgePanel.namePlaceholder')}
              className="w-full px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-muted)]"
              autoComplete="off"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm text-[var(--color-text-secondary)] mb-2">
              {t('knowledgePanel.descLabel')}
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('knowledgePanel.descPlaceholder')}
              rows={3}
              className="w-full px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-muted)] resize-none"
              autoComplete="off"
            />
          </div>

          <div className="flex items-center gap-2 pt-2">
            <AlertCircle size={14} className="text-[var(--color-text-muted)]" />
            <span className="text-xs text-[var(--color-text-muted)]">
              {t('knowledgePanel.supportedFormats')}
            </span>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
            >
              {t('knowledgePanel.cancel')}
            </button>
            <button
              type="submit"
              disabled={!name.trim()}
              className="px-4 py-2 bg-[var(--color-accent)] hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-all"
            >
              {t('knowledgePanel.create')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
