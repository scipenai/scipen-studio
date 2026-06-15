/**
 * @file App.tsx - Application Root Component
 * @description React app root component, manages global layout, routing and hooks initialization
 * @depends services/core, hooks, LogService
 */

import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef } from 'react';
import { CommandPalette } from './components/CommandPalette';
import { ErrorBoundary } from './components/ErrorBoundary';
import { FileConflictModal } from './components/FileConflictModal';
import { BrowseLabelsDialog } from './components/history/BrowseLabelsDialog';
import { BrowseSessionsDialog } from './components/history/BrowseSessionsDialog';
import { NewLabelDialog } from './components/history/NewLabelDialog';
import { autoLabelScheduler } from './services/core/AutoLabelScheduler';
import { WelcomeScreen } from './components/WelcomeScreen';
import { Sidebar } from './components/layout/Sidebar';
import { StatusBar } from './components/layout/StatusBar';
import { SettingsPage } from './components/pages/SettingsPage';
import { ResearchWorkspaceShell } from './components/research/ResearchWorkspaceShell';
import { createLogger, setupGlobalErrorHandlers } from './services/LogService';
import {
  getUIService,
  useIsCommandPaletteOpen,
  useProjectPath,
  useSidebarTab,
} from './services/core';

import {
  useAIConfigSync,
  useAgentBridge,
  useFileOpen,
  useFileWatcher,
  useGlobalShortcuts,
  useLSPInit,
  useLocaleSync,
  useMemoryCleanup,
  useThemeSync,
  useZoteroMirrorLifecycle,
} from './hooks';

setupGlobalErrorHandlers();

const logger = createLogger('App');

function AppContent() {
  const projectPath = useProjectPath();
  const isCommandPaletteOpen = useIsCommandPaletteOpen();
  const sidebarTab = useSidebarTab();
  const showStatusBar = Boolean(projectPath);
  const isSettingsMode = sidebarTab === 'settings';
  const previousWorkspaceTabRef = useRef<'im' | 'files'>('im');

  useThemeSync();
  useLocaleSync();
  useAIConfigSync();
  useLSPInit();
  useFileWatcher();
  useGlobalShortcuts();
  useMemoryCleanup();
  useFileOpen();
  useAgentBridge();
  useZoteroMirrorLifecycle();

  useEffect(() => {
    if (sidebarTab === 'im' || sidebarTab === 'files') {
      previousWorkspaceTabRef.current = sidebarTab;
    }
  }, [sidebarTab]);

  useEffect(() => {
    if (!projectPath && sidebarTab !== 'settings' && sidebarTab !== 'home') {
      getUIService().setSidebarTab('home');
    }
  }, [projectPath, sidebarTab]);

  const handleCloseCommandPalette = () => {
    getUIService().setCommandPaletteOpen(false);
  };

  const handleCloseSettings = () => {
    getUIService().setSidebarTab(projectPath ? previousWorkspaceTabRef.current : 'home');
  };

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
              <motion.div
                key="welcome"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className={`flex-1 overflow-hidden${isSettingsMode ? ' pointer-events-none' : ''}`}
                aria-hidden={isSettingsMode}
              >
                <WelcomeScreen />
              </motion.div>
            ) : (
              <motion.div
                key="research-workspace"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className={`flex-1 overflow-hidden${isSettingsMode ? ' pointer-events-none' : ''}`}
                aria-hidden={isSettingsMode}
              >
                <ResearchWorkspaceShell />
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {isSettingsMode && (
              <motion.div
                key="settings-overlay"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 z-20 overflow-hidden"
              >
                <SettingsPage onClose={handleCloseSettings} />
              </motion.div>
            )}
          </AnimatePresence>
        </main>
      </div>

      {showStatusBar && <StatusBar />}

      <CommandPalette isOpen={isCommandPaletteOpen} onClose={handleCloseCommandPalette} />

      <NewLabelDialog />
      <BrowseLabelsDialog />
      <BrowseSessionsDialog />

      <FileConflictModal />
    </div>
  );
}

/**
 * Main application component
 * Wrapped with ErrorBoundary to catch global errors
 */
function App() {
  useEffect(() => {
    logger.info('SciPen Studio started');
    autoLabelScheduler.start();
    return () => autoLabelScheduler.stop();
  }, []);

  return (
    <ErrorBoundary
      onError={(error, errorInfo) => {
        logger.fatal('Application crashed', {
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
