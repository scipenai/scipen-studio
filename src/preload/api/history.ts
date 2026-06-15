/**
 * @file Preload history API.
 *
 * Typed bridge for renderer code; mirrors the zod schemas in
 * `src/main/ipc/historyHandlers.ts`. Renderer code accesses these via
 * `window.api.history.*`.
 */

import { ipcRenderer } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';

export type LabelKindWire = 'manual' | 'auto' | 'milestone';
export type StepOriginWire = 'snaca_tool' | 'human_edit' | 'merge';

export interface HistoryEnsureSessionInput {
  projectId: string;
  id: string;
  chatThreadId: string | null;
  parentSession: string | null;
}

export interface HistoryCreateLabelInput {
  projectId: string;
  name: string;
  description?: string;
  kind: LabelKindWire;
  createdBy: string;
  files: Array<{ fileId: string; blobHashHex: string; version: number }>;
}

export interface HistoryLabelDTO {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  kind: LabelKindWire;
  createdAt: number;
  createdBy: string;
}

export interface HistoryStepDTO {
  hash: Uint8Array;
  parentHash: Uint8Array | null;
  projectId: string;
  sessionId: string;
  treeHash: Uint8Array;
  causes: Uint8Array;
  origin: StepOriginWire;
  ts: number;
  sizeDelta: number;
}

export const historyApi = {
  ensureSession: (input: HistoryEnsureSessionInput): Promise<{ ok: true }> =>
    ipcRenderer.invoke(IpcChannel.History_EnsureSession, input),

  createLabel: (input: HistoryCreateLabelInput): Promise<HistoryLabelDTO> =>
    ipcRenderer.invoke(IpcChannel.History_CreateLabel, input),

  listLabels: (input: { projectId: string; limit?: number }): Promise<HistoryLabelDTO[]> =>
    ipcRenderer.invoke(IpcChannel.History_ListLabels, input),

  resolveLabelSnapshot: (input: {
    projectId: string;
    labelId: string;
  }): Promise<Record<string, Uint8Array>> =>
    ipcRenderer.invoke(IpcChannel.History_ResolveLabelSnapshot, input),

  getStep: (input: { projectId: string; hashHex: string }): Promise<HistoryStepDTO | null> =>
    ipcRenderer.invoke(IpcChannel.History_GetStep, input),

  listSessionSteps: (input: {
    projectId: string;
    sessionId: string;
    limit?: number;
  }): Promise<HistoryStepDTO[]> =>
    ipcRenderer.invoke(IpcChannel.History_ListSessionSteps, input),
};

export type HistoryApi = typeof historyApi;
