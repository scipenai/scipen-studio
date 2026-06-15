/**
 * @file History IPC handlers.
 *
 * Renderer → main bridge for the per-project history (label / step / session
 * read paths). Chunk and step *write* paths are deliberately NOT exposed: they
 * are driven by the in-process ChunkWriter (M6) so the renderer can never push
 * malformed history blobs into the store.
 *
 * All inputs are zod-validated at the boundary; `projectId` is double-bounded
 * (regex here + a second regex inside `HistoryManager.getOrCreate`) so a
 * malicious renderer can't tunnel past one layer.
 */

import { ipcMain } from 'electron';
import { z } from 'zod';
import { IpcChannel } from '../../../shared/ipc/channels';
import { createLogger } from '../services/LoggerService';
import type { HistoryManager } from '../services/history/HistoryManager';

const logger = createLogger('HistoryHandlers');

export interface HistoryHandlersDeps {
  historyManager: HistoryManager;
}

// ----- shared shapes -----

const projectIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const hashHexSchema = z.string().regex(/^[0-9a-f]{64}$/);
const labelIdSchema = z.string().min(1).max(128);
const sessionIdSchema = z.string().min(1).max(256);
const fileIdSchema = z.string().min(1).max(1024);

const ensureSessionSchema = z.object({
  projectId: projectIdSchema,
  id: sessionIdSchema,
  chatThreadId: z.string().max(256).nullable(),
  parentSession: sessionIdSchema.nullable(),
});

const createLabelSchema = z.object({
  projectId: projectIdSchema,
  name: z.string().min(1).max(256),
  description: z.string().max(2048).optional(),
  kind: z.enum(['manual', 'auto', 'milestone']),
  createdBy: z.string().min(1).max(128),
  files: z
    .array(
      z.object({
        fileId: fileIdSchema,
        blobHashHex: hashHexSchema,
        version: z.number().int().nonnegative(),
      })
    )
    .max(2048),
});

const listLabelsSchema = z.object({
  projectId: projectIdSchema,
  limit: z.number().int().positive().max(500).optional(),
});

const resolveLabelSnapshotSchema = z.object({
  projectId: projectIdSchema,
  labelId: labelIdSchema,
});

const getStepSchema = z.object({
  projectId: projectIdSchema,
  hashHex: hashHexSchema,
});

const listSessionStepsSchema = z.object({
  projectId: projectIdSchema,
  sessionId: sessionIdSchema,
  limit: z.number().int().positive().max(2000).optional(),
});

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

export function registerHistoryHandlers(deps: HistoryHandlersDeps): void {
  const { historyManager } = deps;

  ipcMain.handle(IpcChannel.History_EnsureSession, (_e, raw: unknown) => {
    const p = parseOrThrow(ensureSessionSchema, raw, 'ensureSession');
    historyManager.getOrCreate(p.projectId).ensureSession({
      id: p.id,
      projectId: p.projectId,
      chatThreadId: p.chatThreadId,
      parentSession: p.parentSession,
    });
    return { ok: true as const };
  });

  ipcMain.handle(IpcChannel.History_CreateLabel, async (_e, raw: unknown) => {
    const p = parseOrThrow(createLabelSchema, raw, 'createLabel');
    const label = await historyManager.getOrCreate(p.projectId).createLabel({
      projectId: p.projectId,
      name: p.name,
      description: p.description,
      kind: p.kind,
      createdBy: p.createdBy,
      files: p.files,
    });
    return label;
  });

  ipcMain.handle(IpcChannel.History_ListLabels, async (_e, raw: unknown) => {
    const p = parseOrThrow(listLabelsSchema, raw, 'listLabels');
    return await historyManager.getOrCreate(p.projectId).listLabels(p.projectId, p.limit);
  });

  ipcMain.handle(IpcChannel.History_ResolveLabelSnapshot, async (_e, raw: unknown) => {
    const p = parseOrThrow(resolveLabelSnapshotSchema, raw, 'resolveLabelSnapshot');
    // Map → plain object for IPC structured clone; Uint8Array is transferable.
    const map = await historyManager.getOrCreate(p.projectId).resolveLabelSnapshot(p.labelId);
    const out: Record<string, Uint8Array> = {};
    for (const [k, v] of map) out[k] = v;
    return out;
  });

  ipcMain.handle(IpcChannel.History_GetStep, async (_e, raw: unknown) => {
    const p = parseOrThrow(getStepSchema, raw, 'getStep');
    return await historyManager.getOrCreate(p.projectId).getStep(p.hashHex);
  });

  ipcMain.handle(IpcChannel.History_ListSessionSteps, async (_e, raw: unknown) => {
    const p = parseOrThrow(listSessionStepsSchema, raw, 'listSessionSteps');
    return await historyManager.getOrCreate(p.projectId).listSessionSteps(p.sessionId, p.limit);
  });

  logger.info('history IPC handlers registered');
}
