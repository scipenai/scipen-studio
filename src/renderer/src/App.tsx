/**
 * @file App.tsx - Application Root Component
 * @description React app root component, manages global layout, routing and hooks initialization
 * @depends services/core, hooks, LogService
 */

import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { CommandPalette } from './components/CommandPalette';
import { ErrorBoundary } from './components/ErrorBoundary';
import { FileConflictModal } from './components/FileConflictModal';
import { WelcomeScreen } from './components/WelcomeScreen';
import { LeftSidebar } from './components/layout/LeftSidebar';
import { MainLayout } from './components/layout/MainLayout';
import { Sidebar } from './components/layout/Sidebar';
import { StatusBar } from './components/layout/StatusBar';
import { SettingsPage } from './components/pages/SettingsPage';
import { createLogger, setupGlobalErrorHandlers } from './services/LogService';
import {
  getUIService,
  useIsCommandPaletteOpen,
  useIsSidebarCollapsed,
  useProjectPath,
  useSidebarTab,
} from './services/core';

import {
  useAIConfigSync,
  useFileOpen,
  useFileWatcher,
  useGlobalShortcuts,
  useKnowledgeConfigSync,
  useLSPInit,
  useLocaleSync,
  useMemoryCleanup,
  useOverleafFlushOnUnload,
  useThemeSync,
} from './hooks';

setupGlobalErrorHandlers();

const logger = createLogger('App');

function AppContent() {
  const projectPath = useProjectPath();
  const isCommandPaletteOpen = useIsCommandPaletteOpen();
  const sidebarTab = useSidebarTab();
  const isSidebarCollapsed = useIsSidebarCollapsed();
  const uiService = getUIService();

  const isSettingsMode = sidebarTab === 'aiconfig' || sidebarTab === 'settings';

  useThemeSync();
  useLocaleSync();
  useKnowledgeConfigSync();
  useAIConfigSync();
  useLSPInit();
  useFileWatcher();
  useGlobalShortcuts();
  useMemoryCleanup();
  useOverleafFlushOnUnload();
  useFileOpen();

  const handleCloseCommandPalette = () => {
    getUIService().setCommandPaletteOpen(false);
  };

  // Persist layout changes
  const onLayout = useCallback(
    (sizes: number[]) => {
      // sizes is percentage array [sidebar, main]
      // Estimate pixel width from current window width and store in UIService
      const windowWidth = window.innerWidth;
      const sidebarWidth = (sizes[0] / 100) * windowWidth;
      // Only update when sidebar is visible
      if (!isSidebarCollapsed && sidebarWidth > 50) {
        uiService.setSidebarWidth(Math.round(sidebarWidth));
      }
    },
    [isSidebarCollapsed, uiService]
  );

  return (
    <div
      className="flex flex-col h-screen w-screen overflow-hidden"
      style={{ background: 'var(--color-bg-void)' }}
    >
      <div className="flex flex-1 overflow-hidden">
        {projectPath && <Sidebar />}

        <main className="flex-1 flex flex-col overflow-hidden relative">
          <AnimatePresence mode="wait">
            {!projectPath ? (
              <WelcomeScreen key="welcome" />
            ) : (
              <motion.div
                key="workspace"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className={`flex-1 flex overflow-hidden${isSettingsMode ? ' pointer-events-none' : ''}`}
                aria-hidden={isSettingsMode}
              >
                <PanelGroup
                  direction="horizontal"
                  autoSaveId="scipen-main-layout"
                  className="h-full"
                  onLayout={onLayout}
                >
                  <LeftSidebarPanel />

                  <Panel order={2} className="h-full">
                    <div className="h-full w-full">
                      <MainLayout />
                    </div>
                  </Panel>
                </PanelGroup>
              </motion.div>
            )}
          </AnimatePresence>

          {projectPath && (
            <AnimatePresence>
              {isSettingsMode && (
                <motion.div
                  key="settings"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="absolute inset-0 z-20 overflow-hidden"
                >
                  <SettingsPage />
                </motion.div>
              )}
            </AnimatePresence>
          )}
        </main>
      </div>

      {projectPath && <StatusBar />}

      <CommandPalette isOpen={isCommandPaletteOpen} onClose={handleCloseCommandPalette} />

      <FileConflictModal />
    </div>
  );
}

const LeftSidebarPanel: React.FC = () => {
  const isSidebarCollapsed = useIsSidebarCollapsed();

  if (isSidebarCollapsed) {
    return null;
  }

  return (
    <>
      <Panel defaultSize={20} minSize={10} maxSize={40} id="left-sidebar" order={1}>
        <LeftSidebar />
      </Panel>
      <PanelResizeHandle className="w-1 bg-editor-border hover:bg-primary-500/50 transition-colors duration-150 cursor-col-resize group">
        <div className="w-full h-full flex items-center justify-center">
          <div className="w-0.5 h-8 bg-transparent group-hover:bg-primary-500/70 rounded-full transition-colors" />
        </div>
      </PanelResizeHandle>
    </>
  );
};

/**
 * Main application component
 * Wrapped with ErrorBoundary to catch global errors
 */
function App() {
  useEffect(() => {
    logger.info('SciPen Studio 启动');
  }, []);

  return (
    <ErrorBoundary
      onError={(error, errorInfo) => {
        logger.fatal('应用程序崩溃', {
          error: error.message,
          stack: error.stack,
          componentStack: errorInfo.componentStack,
        });
      }}
    >
      <AppContent />
    </ErrorBoundary>
  );
}

export default App;
