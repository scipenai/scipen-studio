/**
 * @file Selection Assistant IPC Handlers (Type-Safe)
 * @description Handles text selection capture, action window control, and knowledge base integration.
 * @depends ISelectionService, IKnowledgeService, createTypedHandlers
 * @security Uses Zod schema validation via createTypedHandlers for all IPC inputs
 */

import { IpcChannel } from '@shared/ipc/channels';
import type {
  SelectionAddToKnowledgeDTO,
  SelectionCaptureDTO,
  SelectionConfigDTO,
} from '@shared/ipc/types';
import type { BrowserWindow } from 'electron';
import { createLogger } from '../services/LoggerService';
import type { ISelectionService, SelectionCaptureData } from '../services/interfaces';
import type { IKnowledgeService } from '../services/interfaces';
import { createTypedHandlers } from './typedIpc';

const logger = createLogger('SelectionHandlers');

/**
 * Dependencies required for selection handler registration.
 */
export interface SelectionHandlersDeps {
  /** Retrieves the selection service instance */
  getSelectionService: () => ISelectionService;
  /** Retrieves the knowledge service instance */
  getKnowledgeService: () => IKnowledgeService;
  /** Retrieves the main browser window */
  getMainWindow: () => BrowserWindow | null;
}

/**
 * Converts domain model to DTO for IPC transfer.
 */
function toSelectionCaptureDTO(data: SelectionCaptureData): SelectionCaptureDTO {
  return {
    text: data.text,
    sourceApp: data.sourceApp,
    capturedAt: new Date(data.capturedAt).toISOString(),
    cursorPosition: data.cursorPosition,
  };
}

/**
 * Registers all selection assistant IPC handlers.
 * @sideeffect Registers ipcMain handlers for selection operations
 */
export function registerSelectionHandlers(deps: SelectionHandlersDeps): void {
  const { getSelectionService, getKnowledgeService } = deps;

  logger.info('[SelectionHandlers] Registering selection IPC handlers...');

  const handlers = createTypedHandlers(
    {
      // ====== Configuration ======

      /** Sets the selection assistant enabled state */
      [IpcChannel.Selection_SetEnabled]: async (enabled: boolean) => {
        try {
          const service = getSelectionService();
          const success = await service.setEnabled(enabled);

          logger.info(
            `[SelectionHandlers] Selection assistant ${enabled ? 'enabled' : 'disabled'}`
          );
          return { success };
        } catch (error) {
          logger.error('[SelectionHandlers] Failed to set enabled state:', error);
          return { success: false, error: String(error) };
        }
      },

      /** Gets the selection assistant enabled state */
      [IpcChannel.Selection_IsEnabled]: () => {
        try {
          const service = getSelectionService();
          return service.isEnabled();
        } catch (error) {
          logger.error('[SelectionHandlers] Failed to get enabled state:', error);
          return false;
        }
      },

      /** Gets the selection assistant configuration */
      [IpcChannel.Selection_GetConfig]: (): SelectionConfigDTO | null => {
        try {
          const service = getSelectionService();
          const config = service.getConfig();
          return {
            enabled: config.enabled,
            triggerMode: config.triggerMode,
            shortcutKey: config.shortcutKey,
            defaultLibraryId: config.defaultLibraryId,
          };
        } catch (error) {
          logger.error('[SelectionHandlers] Failed to get config:', error);
          return null;
        }
      },

      /** Updates the selection assistant configuration */
      [IpcChannel.Selection_SetConfig]: async (config: Partial<SelectionConfigDTO>) => {
        try {
          const service = getSelectionService();
          await service.updateConfig(config);
          logger.info('[SelectionHandlers] Config updated:', config);
          return { success: true };
        } catch (error) {
          logger.error('[SelectionHandlers] Failed to set config:', error);
          return { success: false, error: String(error) };
        }
      },

      // ====== Selection Operations ======

      /** Captures and returns the current selected text */
      [IpcChannel.Selection_GetText]: async (): Promise<SelectionCaptureDTO | null> => {
        try {
          const service = getSelectionService();
          const data = await service.captureCurrentSelection();
          if (!data) {
            return null;
          }
          return toSelectionCaptureDTO(data);
        } catch (error) {
          logger.error('[SelectionHandlers] Failed to get selected text:', error);
          return null;
        }
      },

      // ====== Window Control ======

      /** Shows the selection action window */
      [IpcChannel.Selection_ShowActionWindow]: (data?: SelectionCaptureDTO) => {
        try {
          const service = getSelectionService();

          if (data) {
            // Use provided data
            const captureData: SelectionCaptureData = {
              text: data.text,
              sourceApp: data.sourceApp,
              capturedAt: data.capturedAt ? new Date(data.capturedAt).getTime() : Date.now(),
              cursorPosition: data.cursorPosition,
            };
            service.showActionWindow(captureData);
          } else {
            // Capture current selection and show
            service.captureCurrentSelection().then((capturedData) => {
              if (capturedData) {
                service.showActionWindow(capturedData);
              }
            });
          }

          return { success: true };
        } catch (error) {
          logger.error('[SelectionHandlers] Failed to show ActionWindow:', error);
          return { success: false, error: String(error) };
        }
      },

      /** Hides the selection action window */
      [IpcChannel.Selection_HideActionWindow]: () => {
        try {
          const service = getSelectionService();
          service.hideActionWindow();
          return { success: true };
        } catch (error) {
          logger.error('[SelectionHandlers] Failed to hide ActionWindow:', error);
          return { success: false, error: String(error) };
        }
      },

      /** Hides the selection toolbar */
      [IpcChannel.Selection_HideToolbar]: () => {
        try {
          const service = getSelectionService();
          service.hideToolbar();
          return { success: true };
        } catch (error) {
          logger.error('[SelectionHandlers] Failed to hide Toolbar:', error);
          return { success: false, error: String(error) };
        }
      },

      // ====== Knowledge Base Integration ======

      /**
       * Adds selected text to knowledge base (aggregated by month).
       * @sideeffect Creates or updates monthly clip document in the library
       */
      [IpcChannel.Selection_AddToKnowledge]: async (dto: SelectionAddToKnowledgeDTO) => {
        try {
          const knowledgeService = getKnowledgeService();

          // Calls knowledge service to add clip (auto-aggregated to monthly file)
          const result = await knowledgeService.addClip(dto.libraryId, {
            text: dto.text,
            sourceApp: dto.metadata?.sourceApp,
            capturedAt: dto.metadata?.capturedAt || new Date().toISOString(),
            note: dto.note,
            tags: dto.metadata?.tags,
          });

          logger.info(`[SelectionHandlers] Clip added to knowledge base: ${dto.libraryId}`);
          return { success: true, taskId: result.taskId };
        } catch (error) {
          logger.error('[SelectionHandlers] Failed to add clip:', error);
          return { success: false, error: String(error) };
        }
      },
    },
    { logErrors: true }
  );

  handlers.registerAll();
  logger.info('[SelectionHandlers] Selection IPC handlers registered (type-safe)');
}
