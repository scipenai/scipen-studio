/**
 * @file useResearchWorkspaceActions.ts
 * @description Callback collection extracted from ResearchWorkspaceShell — message sending,
 * artifact operations, and layout toggling.
 */

import { useCallback } from 'react';
import type { ArtifactSummary } from '../../../../../shared/types/chat';
import type { UIService } from '../../services/core/UIService';
import { t } from '../../locales';
import { openFileInEditor } from '../../services/core/FileOpenService';
import type { PendingErrorDraftContext } from './researchWorkspaceHelpers';

// ─── Param types ───────────────────────────────────

export interface UseResearchWorkspaceActionsParams {
  uiService: UIService;
  chatSendMessage: (
    content: string,
    options: { workspace: { projectPath: string | null; activeFilePath: string | null } }
  ) => Promise<void>;
  projectPath: string | null;
  activeTabPath: string | null;
  activeArtifactPath: string | null;
  workspaceMode: 'chat' | 'chat-editor' | 'chat-editor-preview';
  isPreviewVisible: boolean;
  inputValue: string;
  setInputValue: (value: string) => void;
  pendingErrorDraft: PendingErrorDraftContext | null;
  setPendingErrorDraft: (value: PendingErrorDraftContext | null) => void;
  setChatError: (value: string | null) => void;
}

// ─── Return type ───────────────────────────────────

export interface ResearchWorkspaceActions {
  sendWithWorkspaceContext: (content: string) => Promise<void>;
  handleSend: () => Promise<void>;
  handleAcceptAutoFix: () => Promise<void>;
  openArtifactInEditor: (path: string, mode: 'editor' | 'preview') => Promise<void>;
  handleSendStable: () => void;
  handleOpenSettings: () => void;
  handleOpenArtifactStable: (artifact: ArtifactSummary) => void;
  handleCompileArtifactStable: (artifact: ArtifactSummary) => void;
  handleAcceptAutoFixStable: () => void;
  handleDismissDraftContextBadge: () => void;
  toggleEditorLayout: () => Promise<void>;
  togglePreviewLayout: () => Promise<void>;
}

// ─── Hook ─────────────────────────────────────────

export function useResearchWorkspaceActions(
  params: UseResearchWorkspaceActionsParams
): ResearchWorkspaceActions {
  const {
    uiService,
    chatSendMessage,
    projectPath,
    activeTabPath,
    activeArtifactPath,
    workspaceMode,
    isPreviewVisible,
    inputValue,
    setInputValue,
    pendingErrorDraft,
    setPendingErrorDraft,
    setChatError,
  } = params;

  const sendWithWorkspaceContext = useCallback(
    async (content: string) => {
      try {
        await chatSendMessage(content, {
          workspace: {
            projectPath,
            activeFilePath: activeTabPath,
          },
        });
        setChatError(null);
      } catch (error) {
        console.error('[ResearchWorkspaceShell] Built-in chat send failed:', error);
        const message =
          error instanceof Error && error.message.trim()
            ? error.message
            : t('research.sendFailedRetry');
        setChatError(message);
      }
    },
    [activeTabPath, chatSendMessage, projectPath, setChatError]
  );

  const handleSend = useCallback(async () => {
    const next = inputValue.trim();
    if (!next) return;
    setChatError(null);
    const payload = pendingErrorDraft?.hiddenContext
      ? `${next}\n\n${pendingErrorDraft.hiddenContext}`
      : next;
    setInputValue('');
    setPendingErrorDraft(null);
    await sendWithWorkspaceContext(payload);
  }, [
    inputValue,
    pendingErrorDraft,
    sendWithWorkspaceContext,
    setChatError,
    setInputValue,
    setPendingErrorDraft,
  ]);

  const handleAcceptAutoFix = useCallback(async () => {
    setChatError(null);
    await sendWithWorkspaceContext(t('research.acceptAutoFixPrompt'));
  }, [sendWithWorkspaceContext, setChatError]);

  const openArtifactInEditorCb = useCallback(
    async (path: string, mode: 'editor' | 'preview') => {
      await openFileInEditor(path);
      uiService.setSidebarTab('im');
      uiService.setActiveArtifactPath(path);
      if (mode === 'preview') {
        uiService.setWorkspaceMode('chat-editor-preview');
        uiService.setRightPanelTab('preview');
        uiService.setRightPanelCollapsed(false);
        uiService.setPreviewVisible(true);
      } else {
        uiService.setWorkspaceMode('chat-editor');
        uiService.setRightPanelCollapsed(true);
        uiService.setPreviewVisible(false);
      }
    },
    [uiService]
  );

  const handleOpenArtifact = useCallback(
    async (artifact: ArtifactSummary) => {
      await openArtifactInEditorCb(artifact.path, 'editor');
    },
    [openArtifactInEditorCb]
  );

  const handleCompileArtifact = useCallback(
    async (artifact: ArtifactSummary) => {
      await openArtifactInEditorCb(artifact.path, 'preview');
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('trigger-compile'));
      });
    },
    [openArtifactInEditorCb]
  );

  const handleSendStable = useCallback(() => {
    void handleSend();
  }, [handleSend]);
  const handleOpenSettings = useCallback(() => {
    uiService.setSidebarTab('settings');
  }, [uiService]);
  const handleOpenArtifactStable = useCallback(
    (artifact: ArtifactSummary) => {
      void handleOpenArtifact(artifact);
    },
    [handleOpenArtifact]
  );
  const handleCompileArtifactStable = useCallback(
    (artifact: ArtifactSummary) => {
      void handleCompileArtifact(artifact);
    },
    [handleCompileArtifact]
  );
  const handleAcceptAutoFixStable = useCallback(() => {
    void handleAcceptAutoFix();
  }, [handleAcceptAutoFix]);
  const handleDismissDraftContextBadge = useCallback(() => {
    setPendingErrorDraft(null);
  }, [setPendingErrorDraft]);

  const toggleEditorLayout = useCallback(async () => {
    if (workspaceMode === 'chat-editor') {
      uiService.setWorkspaceMode('chat');
      uiService.setRightPanelCollapsed(true);
      uiService.setPreviewVisible(false);
      return;
    }

    const targetPath = activeTabPath || activeArtifactPath;
    if (targetPath && !activeTabPath) {
      await openFileInEditor(targetPath);
    }
    uiService.setSidebarTab('im');
    uiService.setWorkspaceMode('chat-editor');
    uiService.setRightPanelCollapsed(true);
    uiService.setPreviewVisible(false);
  }, [activeArtifactPath, activeTabPath, uiService, workspaceMode]);

  const togglePreviewLayout = useCallback(async () => {
    if (workspaceMode === 'chat-editor-preview' && isPreviewVisible) {
      uiService.setWorkspaceMode('chat');
      uiService.setRightPanelCollapsed(true);
      uiService.setPreviewVisible(false);
      return;
    }

    const targetPath = activeTabPath || activeArtifactPath;
    if (targetPath && !activeTabPath) {
      await openFileInEditor(targetPath);
    }
    uiService.setSidebarTab('im');
    uiService.setWorkspaceMode('chat-editor-preview');
    uiService.setRightPanelTab('preview');
    uiService.setRightPanelCollapsed(false);
    uiService.setPreviewVisible(true);
  }, [activeArtifactPath, activeTabPath, isPreviewVisible, uiService, workspaceMode]);

  return {
    sendWithWorkspaceContext,
    handleSend,
    handleAcceptAutoFix,
    openArtifactInEditor: openArtifactInEditorCb,
    handleSendStable,
    handleOpenSettings,
    handleOpenArtifactStable,
    handleCompileArtifactStable,
    handleAcceptAutoFixStable,
    handleDismissDraftContextBadge,
    toggleEditorLayout,
    togglePreviewLayout,
  };
}
