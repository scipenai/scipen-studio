/**
 * @file useLSPInit.ts - LSP initialization Hook
 * @description Manages LSP service lifecycle with lazy loading strategy.
 *              TexLab and Tinymist are started on-demand when .tex/.typ files are opened.
 * @depends api, LSPService, LogService, ProjectService, useEvent
 */
import { useEffect, useRef } from 'react';
import { api } from '../api';
import { LSPService } from '../services/LSPService';
import { createLogger } from '../services/LogService';
import { getProjectService } from '../services/core';
import { useIpcEvent } from './useEvent';

const logger = createLogger('LSPInit');

/**
 * Manages LSP service lifecycle with lazy loading strategy.
 *
 * @sideeffect Starts/stops LSP services (TexLab/Tinymist) on project open/close
 */
export function useLSPInit() {
  const projectService = getProjectService();
  const projectPath = projectService.projectPath;
  const lspConfiguredRef = useRef(false);

  useIpcEvent(api.lsp.onServiceStarted, (data) => {
    logger.info(`LSP service started: ${data.service}`);
  });

  useIpcEvent(api.lsp.onServiceStopped, (data) => {
    logger.info(`LSP service stopped: ${data.service}`);
  });

  useEffect(() => {
    if (!projectPath) {
      return;
    }

    if (lspConfiguredRef.current) {
      return;
    }

    const isOverleafProject =
      projectPath.startsWith('overleaf://') || projectPath.startsWith('overleaf:');

    /**
     * Why retry: Main process IPC handlers register after window creation.
     * Renderer may attempt calls before handlers are ready - retry handles this race.
     */
    const initLSPWithRetry = async (retries = 3, delay = 500) => {
      for (let attempt = 0; attempt < retries; attempt++) {
        try {
          const available = await LSPService.isAvailable();
          if (available) {
            logger.info('LSP service available');

            const configured = await LSPService.start(projectPath, { virtual: isOverleafProject });
            if (configured) {
              lspConfiguredRef.current = true;
              logger.info(
                'LSP Manager configured (lazy mode)',
                isOverleafProject ? '- virtual mode' : '- local mode'
              );
              logger.info('Services will start on-demand when .tex/.typ files are opened');
            }
          } else {
            logger.info('LSP service unavailable (texlab/tinymist not installed)');
          }
          return;
        } catch (error) {
          const isHandlerNotRegistered =
            error instanceof Error && error.message.includes('No handler registered');

          if (isHandlerNotRegistered && attempt < retries - 1) {
            logger.info(`LSP init waiting for IPC handlers... (${attempt + 1}/${retries})`);
            await new Promise((resolve) => setTimeout(resolve, delay));
          } else {
            logger.error('LSP initialization failed:', error);
            return;
          }
        }
      }
    };

    initLSPWithRetry();

    return () => {
      if (lspConfiguredRef.current) {
        LSPService.stop();
        lspConfiguredRef.current = false;
      }
    };
  }, [projectPath]);
}
