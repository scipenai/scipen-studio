import { AnimatePresence, motion } from 'framer-motion';
import { FolderKanban, MessageSquareText, PanelLeftOpen, PanelRightOpen } from 'lucide-react';
import { Suspense, lazy, useEffect, useMemo, useRef, useState, startTransition } from 'react';
import type React from 'react';
import { Panel, PanelGroup } from 'react-resizable-panels';
import { api } from '../../api';
import { useEvent } from '../../hooks/useEvent';
import { useChatService } from '../../hooks/useChatService';
import {
  getConversationScopeService,
  getUIService,
  useActiveArtifactPath,
  useActiveConversationId,
  useActiveProjectConversation,
  useActiveTabPath,
  useCompilationResult,
  useConversationScope,
  useConversationScopeError,
  usePreviewVisible,
  useProjectPath,
  useProjectRuntime,
  useSettings,
  useSidebarTab,
  useWorkspaceMode,
} from '../../services/core';
import { getChatService } from '../../services/core/ChatService';
import { t } from '../../locales';
import { useProposalProcessor } from '../../hooks/useProposalProcessor';
import { useNativeIM } from '../im/useNativeIM';
import { MainLayout } from '../layout/MainLayout';
import { ResearchConversationPane } from './ResearchConversationPane';
import { IconButton } from '../ui';
import {
  buildAskPromptPartsFromCompileError,
  buildErrorContextBadges,
  buildWorkspaceInputPlaceholder,
  findLatestArtifact,
  getChatPanelDefaultSize,
  getConversationScopeBadge,
  getOpenClawStatus,
  WorkspaceResizeHandle,
} from './researchWorkspaceHelpers';
import type { PendingErrorDraftContext } from './researchWorkspaceHelpers';
import { useResearchWorkspaceActions } from './useResearchWorkspaceActions';

const FileExplorer = lazy(() =>
  import('../FileExplorer').then((module) => ({ default: module.FileExplorer }))
);

export const ResearchWorkspaceShell: React.FC = () => {
  const uiService = getUIService();
  const projectPath = useProjectPath();
  const sidebarTab = useSidebarTab();
  const activeArtifactPath = useActiveArtifactPath();
  const activeTabPath = useActiveTabPath();
  const workspaceMode = useWorkspaceMode();
  const compilationResult = useCompilationResult();
  const settings = useSettings();
  const runtime = useProjectRuntime();
  const chatServiceState = useChatService();
  const activeConversationId = useActiveConversationId();
  const activeProjectConversation = useActiveProjectConversation();
  const conversationScope = useConversationScope();
  const conversationScopeError = useConversationScopeError();
  const conversationScopeService = getConversationScopeService();
  const isPreviewVisible = usePreviewVisible();
  const isOpenClawRuntime = settings.assistant.runtime === 'openclaw';
  const hasIMConfig = Boolean(settings.im.serverUrl && settings.im.token);
  const isBootstrapReady = runtime.bootstrapState === 'ready';
  const imState = useNativeIM({
    baseUrl: settings.im.serverUrl || '',
    token: settings.im.token || '',
    conversationId: activeConversationId || '',
  });
  const isOpenClawReady = Boolean(
    hasIMConfig && activeConversationId && isBootstrapReady && imState.isConnected
  );

  // Auto-process AI proposals: IM message proposals -> Diff Review
  useProposalProcessor(imState.snapshot.messages, runtime.botUserId || undefined, projectPath);

  const [inputValue, setInputValue] = useState('');
  const [chatError, setChatError] = useState<string | null>(null);
  const [pendingErrorDraft, setPendingErrorDraft] = useState<PendingErrorDraftContext | null>(null);
  const [inputPulseKey, setInputPulseKey] = useState(0);
  const hasInitializedLayoutRef = useRef(false);

  const showFilesDrawer = sidebarTab === 'files';
  const showEditorPane = workspaceMode !== 'chat';
  const sessionTitle = isOpenClawRuntime
    ? activeProjectConversation?.title ||
      (projectPath
        ? projectPath.replace(/\\/g, '/').split('/').pop() || 'SciPenClaw'
        : 'SciPenClaw')
    : chatServiceState.currentSession?.title || t('research.newConversation');
  const chatDefaultSize = getChatPanelDefaultSize(workspaceMode);
  const editorDefaultSize = 100 - chatDefaultSize;
  const builtinMessages = useMemo(
    () => (isOpenClawRuntime ? [] : chatServiceState.messages),
    [chatServiceState.messages, isOpenClawRuntime]
  );
  const isGenerating = isOpenClawRuntime
    ? (imState.snapshot.typingUserIds?.length ?? 0) > 0
    : chatServiceState.isGenerating;
  const openClawStatus = getOpenClawStatus({
    hasIMConfig,
    hasActiveConversation: Boolean(activeConversationId),
    isConnected: imState.isConnected,
    isConnecting: imState.isLoading,
    connectionState: imState.snapshot.state,
    isHydrating: conversationScopeService.isHydrating,
    desiredProjectScope: conversationScope.scopeType === 'project',
    activeConversationScope: activeProjectConversation?.scopeType ?? null,
    scopeError: conversationScopeError,
  });
  const scopeBadge = getConversationScopeBadge(
    activeProjectConversation?.scopeType ?? conversationScope.scopeType ?? null
  );
  const latestArtifact = useMemo(
    () =>
      activeArtifactPath && builtinMessages.length > 0
        ? findLatestArtifact(builtinMessages, activeArtifactPath)
        : null,
    [activeArtifactPath, builtinMessages]
  );
  const inputPlaceholder = useMemo(
    () => buildWorkspaceInputPlaceholder(activeTabPath, projectPath),
    [activeTabPath, projectPath]
  );
  const autoFixLabel = useMemo(() => {
    const errorCount =
      compilationResult?.parsedErrors?.length || compilationResult?.errors?.length || 0;
    return errorCount > 0
      ? t('research.autoFixCount', { count: String(errorCount) })
      : t('research.autoFix');
  }, [compilationResult]);

  // ─── Actions hook ────────────────────────────────
  const actions = useResearchWorkspaceActions({
    uiService,
    conversationScopeService,
    isOpenClawRuntime,
    isOpenClawReady,
    openClawStatusText: openClawStatus.text,
    imSendMessage: imState.sendMessage,
    chatSendMessage: chatServiceState.sendMessage,
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
  });

  // Scope activation: project scope is activated explicitly by bootstrapProject()
  // (FileOpenService/WelcomeScreen). This effect only handles the global scope when
  // no project is open.
  useEffect(() => {
    if (!isOpenClawRuntime || projectPath) {
      return;
    }
    void conversationScopeService.activateGlobalScope({
      workspaceId: settings.assistant.openclaw.workspaceId || null,
      title: 'SciPen Global',
    });
  }, [
    conversationScopeService,
    isOpenClawRuntime,
    projectPath,
    settings.assistant.openclaw.workspaceId,
  ]);

  useEffect(() => {
    if (hasInitializedLayoutRef.current) {
      return;
    }
    hasInitializedLayoutRef.current = true;
    uiService.setSidebarTab('im');
    // workspaceMode is restored from storage; do not overwrite unconditionally here.
    uiService.setRightPanelCollapsed(true);
    uiService.setPreviewVisible(false);
    if (uiService.rightPanelTab !== 'preview') {
      uiService.setRightPanelTab('preview');
    }
  }, [uiService]);

  useEvent(
    uiService.onDidRequestAIErrorAnalysis,
    (request) => {
      const promptParts = buildAskPromptPartsFromCompileError(request, projectPath);
      setInputValue(promptParts.visiblePrompt);
      setPendingErrorDraft({
        hiddenContext: promptParts.hiddenContext,
        badges: buildErrorContextBadges(request, projectPath),
      });
      startTransition(() => {
        setInputPulseKey((current) => current + 1);
      });
    },
    [projectPath]
  );

  useEvent(
    uiService.onDidRequestChatWithText,
    ({ text }) => {
      const trimmed = text.trim();
      setInputValue(trimmed ? `> ${trimmed.replace(/\n/g, '\n> ')}\n\n` : '');
      startTransition(() => {
        setInputPulseKey((current) => current + 1);
      });
    },
    []
  );

  // Global text selection capture: SelectionService forwards to the main window via IPC.
  useEffect(() => {
    const dispose = api.selection.onTextCaptured((data) => {
      if (data.text?.trim()) {
        uiService.requestChatWithText(data.text.trim(), 'selection');
      }
    });
    return dispose;
  }, [uiService]);

  useEvent(
    getChatService().onDidError,
    (error) => {
      setChatError(error.message);
    },
    []
  );

  useEffect(() => {
    if (!isOpenClawRuntime) {
      const latestAssistantWithContent =
        [...builtinMessages]
          .reverse()
          .find(
            (message) =>
              message.role === 'assistant' &&
              (message.content.trim() || (message.blocks?.length ?? 0) > 0)
          ) ?? null;
      if (latestAssistantWithContent) {
        setChatError(null);
      }
    }
  }, [builtinMessages, isOpenClawRuntime]);

  return (
    <div className="h-full overflow-hidden p-2" style={{ background: 'var(--color-bg-void)' }}>
      <div
        className="flex h-full flex-col overflow-hidden rounded-[20px] border shadow-[var(--shadow-lg)]"
        style={{
          borderColor: 'var(--color-border-subtle)',
          background: 'color-mix(in srgb, var(--color-bg-primary) 94%, transparent)',
        }}
      >
        <div
          className="flex items-center justify-between border-b px-6 py-4"
          style={{
            borderBottomColor: 'var(--color-border-subtle)',
            background: 'color-mix(in srgb, var(--color-bg-elevated) 88%, transparent)',
          }}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-[17px] font-medium tracking-[-0.03em] text-[var(--color-text-primary)]">
                {sessionTitle}
              </h2>
              {isOpenClawRuntime && (
                <span
                  className="rounded-full px-2.5 py-1 text-[11px] font-medium"
                  style={{
                    background: 'var(--color-success-muted)',
                    color: 'var(--color-success)',
                  }}
                >
                  {scopeBadge}
                </span>
              )}
            </div>
            <div className="mt-1.5 flex items-center gap-2 text-[12px] text-[var(--color-text-muted)]">
              <span className="inline-flex items-center gap-2">
                <span
                  className={`h-2.5 w-2.5 rounded-full ${
                    isOpenClawRuntime
                      ? openClawStatus.tone === 'success'
                        ? 'bg-emerald-500'
                        : openClawStatus.tone === 'info'
                          ? 'bg-sky-500'
                          : 'bg-amber-500'
                      : isGenerating
                        ? 'bg-sky-500'
                        : 'bg-emerald-500'
                  }`}
                />
                {isOpenClawRuntime
                  ? openClawStatus.text
                  : isGenerating
                    ? t('research.scipenReplying')
                    : t('research.startNewConversation')}
              </span>
              {latestArtifact && (
                <span
                  className="rounded-full px-2.5 py-1 text-[11px]"
                  style={{
                    background: 'var(--color-bg-hover)',
                    color: 'var(--color-text-muted)',
                  }}
                >
                  {t('research.recentFile', { title: latestArtifact.title })}
                </span>
              )}
            </div>
          </div>

          <div
            className="flex items-center gap-2 rounded-full border px-2 py-1 shadow-[var(--shadow-sm)]"
            style={{
              borderColor: 'var(--color-border-subtle)',
              background: 'color-mix(in srgb, var(--color-bg-elevated) 92%, transparent)',
            }}
          >
            <IconButton
              size="md"
              variant="ghost"
              active={showFilesDrawer}
              tooltip={
                showFilesDrawer ? t('research.collapseFileDrawer') : t('research.openFileDrawer')
              }
              onClick={() => {
                uiService.setSidebarTab(showFilesDrawer ? 'im' : 'files');
              }}
            >
              <FolderKanban size={16} />
            </IconButton>
            <IconButton
              size="md"
              variant="ghost"
              active={workspaceMode === 'chat'}
              tooltip={t('research.chatMainView')}
              onClick={() => {
                uiService.setWorkspaceMode('chat');
                uiService.setRightPanelCollapsed(true);
                uiService.setPreviewVisible(false);
              }}
            >
              <MessageSquareText size={16} />
            </IconButton>
            <IconButton
              size="md"
              variant="ghost"
              active={workspaceMode === 'chat-editor'}
              tooltip={t('research.chatAndEdit')}
              onClick={() => {
                void actions.toggleEditorLayout();
              }}
            >
              <PanelLeftOpen size={16} />
            </IconButton>
            <IconButton
              size="md"
              variant="ghost"
              active={workspaceMode === 'chat-editor-preview' && isPreviewVisible}
              tooltip={t('research.chatEditPreview')}
              onClick={() => {
                void actions.togglePreviewLayout();
              }}
            >
              <PanelRightOpen size={16} />
            </IconButton>
          </div>
        </div>

        <div className="relative flex-1 min-h-0 overflow-hidden">
          <AnimatePresence>
            {showFilesDrawer && (
              <>
                <motion.button
                  type="button"
                  aria-label={t('research.closeFileDrawer')}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.16 }}
                  className="absolute inset-0 z-10 backdrop-blur-[1px]"
                  style={{
                    background: 'color-mix(in srgb, var(--color-backdrop) 24%, transparent)',
                  }}
                  onClick={() => {
                    uiService.setSidebarTab('im');
                  }}
                />
                <motion.div
                  initial={{ x: -24, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  exit={{ x: -24, opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  className="absolute inset-y-0 left-0 z-20 w-[320px] overflow-hidden rounded-r-[24px] border-r shadow-[var(--shadow-lg)]"
                  style={{
                    borderRightColor: 'var(--color-border)',
                    background: 'color-mix(in srgb, var(--color-bg-elevated) 96%, transparent)',
                  }}
                >
                  <Suspense
                    fallback={
                      <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
                        {t('research.loadingFiles')}
                      </div>
                    }
                  >
                    <FileExplorer />
                  </Suspense>
                </motion.div>
              </>
            )}
          </AnimatePresence>

          <PanelGroup
            direction="horizontal"
            autoSaveId="research-workspace-layout-v4"
            className="h-full"
          >
            <Panel
              id="research-chat"
              order={1}
              defaultSize={chatDefaultSize}
              minSize={22}
              className="min-h-0 min-w-0"
            >
              <ResearchConversationPane
                isOpenClawRuntime={isOpenClawRuntime}
                openClawStatus={openClawStatus}
                hasIMConfig={hasIMConfig}
                conversationScopeError={conversationScopeError}
                isOpenClawReady={isOpenClawReady}
                builtinMessages={builtinMessages}
                imMessages={imState.snapshot.messages}
                imLoading={imState.isLoading || false}
                isGenerating={isGenerating}
                chatError={chatError}
                inputValue={inputValue}
                inputPlaceholder={inputPlaceholder}
                onInputChange={setInputValue}
                onSend={actions.handleSendStable}
                onRetryConnection={actions.handleRetryConnection}
                onOpenSettings={actions.handleOpenSettings}
                onOpenArtifact={actions.handleOpenArtifactStable}
                onCompileArtifact={actions.handleCompileArtifactStable}
                onOpenIMFile={actions.handleOpenIMFile}
                onCompileIMFile={actions.handleCompileIMFile}
                onAcceptAutoFix={actions.handleAcceptAutoFixStable}
                autoFixLabel={autoFixLabel}
                botUserId={runtime.botUserId || undefined}
                draftContextBadges={pendingErrorDraft?.badges ?? []}
                inputPulseKey={inputPulseKey}
                onDismissDraftContextBadge={actions.handleDismissDraftContextBadge}
                activeTabPath={activeTabPath ?? undefined}
              />
            </Panel>

            {showEditorPane && (
              <>
                <WorkspaceResizeHandle />
                <Panel
                  id="research-editor"
                  order={2}
                  defaultSize={editorDefaultSize}
                  minSize={30}
                  className="min-w-0 overflow-hidden"
                  style={{ background: 'var(--color-bg-primary)' }}
                >
                  <MainLayout immersive />
                </Panel>
              </>
            )}
          </PanelGroup>
        </div>
      </div>
    </div>
  );
};
