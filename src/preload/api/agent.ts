/**
 * @file Agent preload API — bridges the SNACA editor-protocol surface to
 *   the renderer.
 *
 * Renderer accesses these as `window.api.agent.*`. All method names mirror
 * the underlying `editor-protocol` semantics so debugging across the boundary
 * is one mental model.
 */

import { ipcRenderer } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import type {
  ChatContext,
  EditConfirmParams,
  EditConfirmResult,
  EditProposeCompleteParams,
  EditProposeDeltaParams,
  EditProposeParams,
  ErrorNotificationParams,
  LogWriteParams,
  MemoryUpdatedParams,
  PlanUpdateParams,
  ThreadSummary,
  ToolApprovalRequestParams,
  ToolConfirmParams,
  TurnDeltaParams,
  UsageUpdateParams,
} from '../../main/services/agent/protocol/schemas';
import type {
  AgentEditAppliedPayload,
  AgentResolveEditProposalParams,
  AgentResolveEditProposalResult,
} from '../../main/services/agent/interfaces/IAgentEditApplyService';
import type { SidecarState } from '../../main/services/agent/interfaces/ISnacaSidecarService';
import { createSafeListener } from './_shared';

export interface AgentSessionState {
  sessionId: string | null;
  threadId: string | null;
  inflightTurn: { turnId: string; kind: 'chat' | 'inline_edit' | 'composer' } | null;
}

export interface StartProjectParams {
  workspaceRoot: string;
  displayName?: string;
  projectType?: 'latex' | 'typst' | 'mixed';
}

export interface StartProjectResult {
  sessionId: string;
  threadId: string;
  threads: ThreadSummary[];
}

export interface SendChatParams {
  content: string;
  context: ChatContext;
}

/** Payload of an inbound `Agent_ContextFlushRequest`. */
export interface AgentContextFlushRequestPayload {
  requestId: string;
  /** Optional whitelist; when omitted, renderer should flush every dirty tab. */
  paths?: string[];
}

/** Renderer's reply via `Agent_ContextFlushResponse`. */
export interface AgentContextFlushResponsePayload {
  requestId: string;
  flushedFiles: string[];
}

export interface SendChatResult {
  turnId: string;
}

export const agentApi = {
  // ------ State queries ------
  getSidecarState: (): Promise<SidecarState> =>
    ipcRenderer.invoke(IpcChannel.Agent_GetSidecarState),

  getSessionState: (): Promise<AgentSessionState> =>
    ipcRenderer.invoke(IpcChannel.Agent_GetSessionState),

  // ------ Project / session lifecycle ------

  /**
   * Open a workspace root as an Agent session. If a session is already
   * active, closes it first. Returns the active session + thread ids.
   */
  startProject: (params: StartProjectParams): Promise<StartProjectResult> =>
    ipcRenderer.invoke(IpcChannel.Agent_StartProject, params),

  // ------ Thread ------

  newThread: (title?: string): Promise<{ threadId: string; title: string }> =>
    ipcRenderer.invoke(IpcChannel.Agent_NewThread, title),

  switchThread: (threadId: string): Promise<{ switched: true }> =>
    ipcRenderer.invoke(IpcChannel.Agent_SwitchThread, threadId),

  listThreads: (): Promise<ThreadSummary[]> =>
    ipcRenderer.invoke(IpcChannel.Agent_ListThreads),

  // ------ Chat ------

  sendChat: (params: SendChatParams): Promise<SendChatResult> =>
    ipcRenderer.invoke(IpcChannel.Agent_SendChat, params),

  cancelTurn: (turnId: string): Promise<{ ok: true }> =>
    ipcRenderer.invoke(IpcChannel.Agent_CancelTurn, turnId),

  confirmEdit: (params: EditConfirmParams): Promise<EditConfirmResult> =>
    ipcRenderer.invoke(IpcChannel.Agent_ConfirmEdit, params),

  confirmTool: (params: ToolConfirmParams): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IpcChannel.Agent_ConfirmTool, params),

  /**
   * host_applies flow: renderer hands a Diff Review decision to main; main
   * writes the file then forwards `editConfirm` to SNACA. Returns the apply
   * outcome (incl. SNACA's confirm reply).
   */
  resolveEditProposal: (
    params: AgentResolveEditProposalParams
  ): Promise<AgentResolveEditProposalResult> =>
    ipcRenderer.invoke(IpcChannel.Agent_ResolveEditProposal, params),

  /**
   * Reply to a `Agent_ContextFlushRequest` event with the list of files the
   * renderer actually flushed to disk. Main resolves the pending reverse-RPC
   * back to SNACA.
   */
  respondContextFlush: (payload: AgentContextFlushResponsePayload): Promise<{ ok: true }> =>
    ipcRenderer.invoke(IpcChannel.Agent_ContextFlushResponse, payload),

  // ------ Streaming events ------

  onSidecarStateChange: createSafeListener<SidecarState>(IpcChannel.Agent_SidecarStateChanged),
  onTurnDelta: createSafeListener<TurnDeltaParams>(IpcChannel.Agent_TurnDelta),
  onEditPropose: createSafeListener<EditProposeParams>(IpcChannel.Agent_EditPropose),
  onEditProposeDelta: createSafeListener<EditProposeDeltaParams>(IpcChannel.Agent_EditProposeDelta),
  onEditProposeComplete: createSafeListener<EditProposeCompleteParams>(
    IpcChannel.Agent_EditProposeComplete
  ),
  onPlanUpdate: createSafeListener<PlanUpdateParams>(IpcChannel.Agent_PlanUpdate),
  onToolApprovalRequest: createSafeListener<ToolApprovalRequestParams>(
    IpcChannel.Agent_ToolApprovalRequest
  ),
  onUsageUpdate: createSafeListener<UsageUpdateParams>(IpcChannel.Agent_UsageUpdate),
  onMemoryUpdated: createSafeListener<MemoryUpdatedParams>(IpcChannel.Agent_MemoryUpdated),
  onError: createSafeListener<ErrorNotificationParams>(IpcChannel.Agent_Error),
  onLog: createSafeListener<LogWriteParams>(IpcChannel.Agent_Log),
  onEditApplied: createSafeListener<AgentEditAppliedPayload>(IpcChannel.Agent_EditApplied),
  onContextFlushRequest: createSafeListener<AgentContextFlushRequestPayload>(
    IpcChannel.Agent_ContextFlushRequest
  ),
};
