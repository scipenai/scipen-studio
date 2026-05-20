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
  EditConfirmResult,
  EditProposeCompleteParams,
  EditProposeDeltaParams,
  EditProposeParams,
  ErrorNotificationParams,
  LogWriteParams,
  MemoryDeleteResult,
  MemoryGetResult,
  MemoryListResult,
  MemoryRevealResult,
  MemoryScope,
  MemoryUpdatedParams,
  MemoryWriteResult,
  PlanUpdateParams,
  SessionGetMessagesResult,
  SkillsGetResult,
  SkillsListResult,
  SkillsReloadResult,
  ThreadSummary,
  ToolApprovalRequestParams,
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

export interface StartComposerParams {
  instruction: string;
  context: ChatContext;
  mode?: 'plan_first' | 'immediate';
  scope?: { paths: string[] };
}

export interface ConfirmPlanParams {
  turnId: string;
  decision: 'accept' | 'reject' | 'modify';
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

export interface AgentConfirmToolParams {
  toolCallId: string;
  decision: 'allow' | 'deny' | 'allow_always' | 'deny_always';
}

export interface AgentConfirmEditParams {
  proposalId: string;
  decision: 'accept' | 'reject' | 'accept_partial';
  perHunk?: Array<{ hunkId: string; decision: 'accept' | 'reject' }>;
  modifiedText?: Array<{ hunkId: string; newText: string }>;
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

  deleteThread: (threadId: string): Promise<{ deleted: boolean }> =>
    ipcRenderer.invoke(IpcChannel.Agent_DeleteThread, threadId),

  renameThread: (threadId: string, title: string): Promise<{ renamed: boolean }> =>
    ipcRenderer.invoke(IpcChannel.Agent_RenameThread, { threadId, title }),

  getMessages: (threadId: string, limit?: number): Promise<SessionGetMessagesResult> =>
    ipcRenderer.invoke(IpcChannel.Agent_GetMessages, { threadId, limit }),

  // ------ Chat ------

  sendChat: (params: SendChatParams): Promise<SendChatResult> =>
    ipcRenderer.invoke(IpcChannel.Agent_SendChat, params),

  startComposer: (params: StartComposerParams): Promise<SendChatResult> =>
    ipcRenderer.invoke(IpcChannel.Agent_StartComposer, params),

  confirmPlan: (params: ConfirmPlanParams): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IpcChannel.Agent_ConfirmPlan, params),

  cancelTurn: (turnId: string): Promise<{ ok: true }> =>
    ipcRenderer.invoke(IpcChannel.Agent_CancelTurn, turnId),

  confirmEdit: (params: AgentConfirmEditParams): Promise<EditConfirmResult> =>
    ipcRenderer.invoke(IpcChannel.Agent_ConfirmEdit, params),

  confirmTool: (params: AgentConfirmToolParams): Promise<{ ok: boolean }> =>
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

  // ------ Memory viewer ------

  memoryList: (scope?: MemoryScope): Promise<MemoryListResult> =>
    ipcRenderer.invoke(IpcChannel.Agent_MemoryList, { scope }),

  memoryGet: (scope: MemoryScope, name: string): Promise<MemoryGetResult> =>
    ipcRenderer.invoke(IpcChannel.Agent_MemoryGet, { scope, name }),

  memoryWrite: (
    scope: MemoryScope,
    name: string,
    content: string
  ): Promise<MemoryWriteResult> =>
    ipcRenderer.invoke(IpcChannel.Agent_MemoryWrite, { scope, name, content }),

  memoryDelete: (scope: MemoryScope, name: string): Promise<MemoryDeleteResult> =>
    ipcRenderer.invoke(IpcChannel.Agent_MemoryDelete, { scope, name }),

  /** When name is undefined, returns the memory directory itself. */
  memoryReveal: (
    scope?: MemoryScope,
    name?: string
  ): Promise<MemoryRevealResult> =>
    ipcRenderer.invoke(IpcChannel.Agent_MemoryReveal, { scope, name }),

  // ------ Skills viewer (read-only) ------

  skillsList: (): Promise<SkillsListResult> =>
    ipcRenderer.invoke(IpcChannel.Agent_SkillsList),

  skillsGet: (name: string): Promise<SkillsGetResult> =>
    ipcRenderer.invoke(IpcChannel.Agent_SkillsGet, { name }),

  skillsReload: (): Promise<SkillsReloadResult> =>
    ipcRenderer.invoke(IpcChannel.Agent_SkillsReload),

  /** Open the Memory & Skills viewer in a secondary window. */
  openMemoryViewer: (initialTab?: 'memory' | 'skills'): Promise<number> =>
    ipcRenderer.invoke(IpcChannel.Agent_OpenMemoryViewer, { initialTab }),

  /**
   * Pre-fetch the fastembed ONNX model into Studio's cache. Resolves
   * with `{ ok: true }` when the model is ready, or `{ ok: false, error }`
   * if download / extract failed. Idempotent — calling on an already
   * cached model returns quickly without re-downloading. Used by
   * Settings before persisting `memory_embedder = "fastembed"`.
   */
  downloadFastEmbed: (): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke(IpcChannel.Agent_FastEmbedDownload),

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
  /** Opaque stderr lines from the running fastembed download. Subscribed
   *  by the Settings download modal so users see signs of life on slow
   *  networks. Each line is whatever fastembed-rs / indicatif emit —
   *  treat as display-only text. */
  onFastEmbedDownloadProgress: createSafeListener<string>(
    IpcChannel.Agent_FastEmbedDownloadProgress
  ),
  onError: createSafeListener<ErrorNotificationParams>(IpcChannel.Agent_Error),
  onLog: createSafeListener<LogWriteParams>(IpcChannel.Agent_Log),
  onEditApplied: createSafeListener<AgentEditAppliedPayload>(IpcChannel.Agent_EditApplied),
  onContextFlushRequest: createSafeListener<AgentContextFlushRequestPayload>(
    IpcChannel.Agent_ContextFlushRequest
  ),
};
