/**
 * @file inlineEditHandlers — IPC bridge for Ctrl+K inline edit.
 *
 * Fan-out shape:
 *   renderer  → main (invoke):
 *     - AI_InlineEditStart { instruction, selectedText, language, … } → { turnId }
 *     - AI_InlineEditCancel(turnId) → { ok }
 *   main → renderer (events broadcast to every live window):
 *     - AI_InlineEditDelta    { turnId, delta }
 *     - AI_InlineEditComplete { turnId, fullText }
 *     - AI_InlineEditError    { turnId, message, code? }
 *
 * Why a dedicated handler file (not folded into `aiHandlers.ts`): the
 * inline edit lifecycle needs event subscription + DisposableStore
 * management, while `aiHandlers` uses the synchronous `typedIpc` registry
 * for plain invoke calls. Mixing the two would dilute both.
 */

import { BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';
import { IpcChannel } from '../../../shared/ipc/channels';
import { DisposableStore } from '../../../shared/utils/lifecycle';
import { createLogger } from '../services/LoggerService';
import type { IInlineEditService } from '../services/interfaces/IInlineEditService';

const logger = createLogger('InlineEditHandlers');

export interface InlineEditHandlersDeps {
  inlineEdit: IInlineEditService;
}

const startParamsSchema = z.object({
  instruction: z.string().min(1).max(2000),
  selectedText: z.string().min(1).max(100_000),
  language: z.string().min(1).max(64),
  fileLabel: z.string().max(1024).optional(),
  surroundingContext: z.string().max(20_000).optional(),
});

const cancelParamsSchema = z.string().min(1).max(128);

function parseOrThrow<T>(schema: z.ZodSchema<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid ${label}: ${issues}`);
  }
  return result.data;
}

export function registerInlineEditHandlers(deps: InlineEditHandlersDeps): DisposableStore {
  const { inlineEdit } = deps;
  const store = new DisposableStore();

  const broadcast = <T>(channel: IpcChannel, payload: T): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    }
  };

  // ----- Event fan-out -----

  store.add(inlineEdit.onDelta((e) => broadcast(IpcChannel.AI_InlineEditDelta, e)));
  store.add(inlineEdit.onComplete((e) => broadcast(IpcChannel.AI_InlineEditComplete, e)));
  store.add(inlineEdit.onError((e) => broadcast(IpcChannel.AI_InlineEditError, e)));

  // ----- Invoke handlers -----

  ipcMain.handle(IpcChannel.AI_InlineEditStart, async (_e, rawParams: unknown) => {
    const params = parseOrThrow(startParamsSchema, rawParams, 'inlineEdit.start params');
    try {
      return await inlineEdit.start(params);
    } catch (err) {
      logger.error('inlineEdit.start failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  });

  ipcMain.handle(IpcChannel.AI_InlineEditCancel, (_e, rawTurnId: unknown) => {
    const turnId = parseOrThrow(cancelParamsSchema, rawTurnId, 'inlineEdit.cancel turnId');
    return inlineEdit.cancel(turnId);
  });

  // Tear down ipcMain handles on dispose so a hot-reload doesn't leak duplicates.
  store.add({
    dispose: () => {
      ipcMain.removeHandler(IpcChannel.AI_InlineEditStart);
      ipcMain.removeHandler(IpcChannel.AI_InlineEditCancel);
    },
  });

  return store;
}
