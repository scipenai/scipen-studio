/**
 * @file Agent IPC handlers — bridges `EditorProtocolClient` to the renderer.
 *
 * Renderer issues requests through `window.api.agent.*`; this module:
 *  1. Routes them to the `IEditorProtocolClient` instance.
 *  2. Fans out streaming notifications (`turn.delta`, `edit.propose`, etc.)
 *     to every BrowserWindow's webContents.
 *
 * The Agent sidecar is auto-started on app boot (see `main/index.ts`).
 * On first `startProject`, a session is opened so subsequent `sendChat`
 * calls have somewhere to land.
 */

import { BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';
import { IpcChannel } from '../../../shared/ipc/channels';
import type { IEditorProtocolClient } from '../services/agent/interfaces/IEditorProtocolClient';
import type {
  ISnacaSidecarService,
  SidecarState,
} from '../services/agent/interfaces/ISnacaSidecarService';
import type { IAgentEditApplyService } from '../services/agent/interfaces/IAgentEditApplyService';
import type { IContextRequestService } from '../services/agent/interfaces/IContextRequestService';
import { EDITOR_PROTOCOL_VERSION } from '../services/agent/protocol/methods';
import {
  ChatContextSchema,
  EditConfirmParamsSchema,
  ToolConfirmParamsSchema,
  type EditConfirmParams,
  type SnacaConfig,
  type ToolConfirmParams,
} from '../services/agent/protocol/schemas';
import { createLogger } from '../services/LoggerService';
import { DisposableStore } from '../../../shared/utils/lifecycle';
import type { IConfigManager } from '../services/interfaces';

const logger = createLogger('AgentHandlers');

export interface AgentHandlersDeps {
  sidecar: ISnacaSidecarService;
  client: IEditorProtocolClient;
  editApply: IAgentEditApplyService;
  contextRequest: IContextRequestService;
  config: IConfigManager;
}

interface AgentSessionState {
  sessionId: string | null;
  threadId: string | null;
  inflightTurn: { turnId: string; kind: 'chat' | 'inline_edit' | 'composer' } | null;
}

const HOST_CAPS = {
  ui_surfaces: ['chat' as const, 'inline_edit' as const, 'composer' as const],
  context_kinds: [
    'active_file' as const,
    'selection' as const,
    'cursor' as const,
    'visible_range' as const,
    'open_tabs' as const,
    'recent_edits' as const,
    'diagnostics' as const,
    'project_meta' as const,
  ],
  edit_apply_strategy: 'host_applies' as const,
  approval_ui: 'local_card' as const,
  framing: ['ndjson' as const],
};

// ----- Input validation schemas (renderer → main) -----
// These mirror what `agentApi` (preload) sends. Note the camelCase shape
// because we haven't translated to wire (snake_case) yet at this boundary.

const startProjectParamsSchema = z.object({
  workspaceRoot: z.string().min(1).max(4096),
  displayName: z.string().max(512).optional(),
  projectType: z.enum(['latex', 'typst', 'mixed']).optional(),
});

const sendChatPayloadSchema = z.object({
  content: z.string().min(1).max(50_000),
  context: ChatContextSchema,
});

const threadTitleSchema = z.string().max(200).optional();
const threadIdSchema = z.string().min(1).max(128);
const turnIdSchema = z.string().min(1).max(128);
const renameThreadPayloadSchema = z.object({
  threadId: threadIdSchema,
  title: z.string().min(1).max(200),
});
const getMessagesPayloadSchema = z.object({
  threadId: threadIdSchema,
  limit: z.number().int().positive().max(1000).optional(),
});

const resolveEditProposalSchema = z.object({
  proposalId: z.string().min(1).max(128),
  decision: z.enum(['accept', 'reject', 'accept_partial']),
  perHunk: z
    .array(
      z.object({
        hunkId: z.string().min(1).max(64),
        decision: z.enum(['accept', 'reject']),
      })
    )
    .max(256)
    .optional(),
  workspaceRoot: z.string().min(1).max(4096).optional(),
});

const contextFlushResponseSchema = z.object({
  requestId: z.string().min(1).max(128),
  flushedFiles: z.array(z.string().max(4096)).max(512),
});

/** Throw a friendly error from a Zod failure so the renderer can surface it. */
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

export function registerAgentHandlers(deps: AgentHandlersDeps): DisposableStore {
  const { sidecar, client, editApply, contextRequest, config } = deps;
  const store = new DisposableStore();

  /** Per-app singleton session/thread for P1. Multi-project comes later. */
  const state: AgentSessionState = {
    sessionId: null,
    threadId: null,
    inflightTurn: null,
  };

  // ----- Sidecar lifecycle: spawn at startup; init on first ready -----

  let initPromise: Promise<void> | null = null;

  const isConnected = (): boolean => client.state.kind === 'connected';

  const initIfNeeded = async (): Promise<void> => {
    if (isConnected()) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      if (sidecar.state.kind !== 'running') {
        await sidecar.start();
      }
      const snacaConfig = buildSnacaConfigFromSettings(config);
      await client.init({
        protocol_version: EDITOR_PROTOCOL_VERSION,
        host: {
          name: 'scipen-studio',
          version: process.env.npm_package_version ?? '0.2.0',
        },
        snaca_config: snacaConfig,
        host_caps: HOST_CAPS,
      });
      logger.info('agent client initialized', { model: snacaConfig.llm.model });
    })();

    try {
      await initPromise;
    } finally {
      // Keep the promise around only when it succeeded; on failure clear so
      // a retry can attempt again.
      if (!isConnected()) {
        initPromise = null;
      }
    }
  };

  // ----- Event fan-out to renderer -----

  const broadcast = <T>(channel: IpcChannel, payload: T): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    }
  };

  store.add(sidecar.onStateChange((s) => broadcast(IpcChannel.Agent_SidecarStateChanged, s)));
  store.add(
    client.onTurnDelta((e) => {
      if (e.kind === 'done') {
        // Clear inflight slot on terminal event.
        if (state.inflightTurn?.turnId === e.turn_id) {
          state.inflightTurn = null;
        }
      }
      broadcast(IpcChannel.Agent_TurnDelta, e);
    })
  );
  store.add(client.onEditPropose((e) => broadcast(IpcChannel.Agent_EditPropose, e)));
  store.add(client.onEditProposeDelta((e) => broadcast(IpcChannel.Agent_EditProposeDelta, e)));
  store.add(client.onEditProposeComplete((e) => broadcast(IpcChannel.Agent_EditProposeComplete, e)));
  store.add(client.onPlanUpdate((e) => broadcast(IpcChannel.Agent_PlanUpdate, e)));
  store.add(
    client.onToolApprovalRequest((e) => broadcast(IpcChannel.Agent_ToolApprovalRequest, e))
  );
  store.add(client.onUsageUpdate((e) => broadcast(IpcChannel.Agent_UsageUpdate, e)));
  store.add(client.onMemoryUpdated((e) => broadcast(IpcChannel.Agent_MemoryUpdated, e)));
  store.add(client.onError((e) => broadcast(IpcChannel.Agent_Error, e)));
  store.add(client.onLog((e) => broadcast(IpcChannel.Agent_Log, e)));
  store.add(editApply.onEditApplied((e) => broadcast(IpcChannel.Agent_EditApplied, e)));

  // Reverse-RPC: SNACA → host via `context.request`. Bind once; the
  // disposable is owned by `store` so a handler swap on hot-reload is clean.
  store.add(client.setContextRequestHandler((req) => contextRequest.handle(req)));

  // ----- Request handlers -----

  ipcMain.handle(IpcChannel.Agent_GetSidecarState, (): SidecarState => sidecar.state);
  ipcMain.handle(IpcChannel.Agent_GetSessionState, (): AgentSessionState => ({ ...state }));

  ipcMain.handle(IpcChannel.Agent_StartProject, async (_e, rawParams: unknown) => {
    const params = parseOrThrow(startProjectParamsSchema, rawParams, 'startProject params');
    await initIfNeeded();
    if (state.sessionId) {
      // Already running — close prior session before opening new one.
      try {
        await client.sessionClose(state.sessionId);
      } catch (err) {
        logger.warn('previous session.close failed', {
          error: (err as Error).message,
        });
      }
      state.sessionId = null;
      state.threadId = null;
      state.inflightTurn = null;
    }

    const projectId = makeProjectIdFromPath(params.workspaceRoot);
    const metadataRoot = buildMetadataRootFor(projectId);
    const sharedMetadataRoot = buildSharedMetadataRoot();

    const result = await client.sessionOpen({
      project_id: projectId,
      workspace_root: normalizePath(params.workspaceRoot),
      metadata_root: normalizePath(metadataRoot),
      shared_metadata_root: normalizePath(sharedMetadataRoot),
      display_name: params.displayName ?? params.workspaceRoot,
      project_type: params.projectType ?? 'latex',
    });

    state.sessionId = result.session_id;
    // SNACA is the single source of truth for active thread.
    state.threadId = result.active_thread_id;

    return {
      sessionId: result.session_id,
      threadId: state.threadId,
      threads: result.threads,
    };
  });

  ipcMain.handle(IpcChannel.Agent_NewThread, async (_e, rawTitle: unknown) => {
    const title = parseOrThrow(threadTitleSchema, rawTitle, 'newThread title');
    requireSession(state);
    const result = await client.sessionNewThread(state.sessionId!, title);
    state.threadId = result.thread_id;
    return { threadId: result.thread_id, title: result.title };
  });

  ipcMain.handle(IpcChannel.Agent_SwitchThread, async (_e, rawThreadId: unknown) => {
    const threadId = parseOrThrow(threadIdSchema, rawThreadId, 'switchThread threadId');
    requireSession(state);
    await client.sessionSwitchThread(state.sessionId!, threadId);
    state.threadId = threadId;
    return { switched: true };
  });

  ipcMain.handle(IpcChannel.Agent_ListThreads, async () => {
    requireSession(state);
    const result = await client.sessionListThreads(state.sessionId!);
    return result.threads;
  });

  ipcMain.handle(IpcChannel.Agent_DeleteThread, async (_e, rawThreadId: unknown) => {
    const threadId = parseOrThrow(threadIdSchema, rawThreadId, 'deleteThread threadId');
    requireSession(state);
    // SNACA picks the most-recently-active surviving thread, or spawns a
    // fresh "New conversation" when none remain. We trust its choice and
    // just mirror the returned active_thread_id into Studio state.
    const result = await client.sessionDeleteThread(state.sessionId!, threadId);
    state.threadId = result.active_thread_id;
    return { deleted: result.deleted, activeThreadId: state.threadId };
  });

  ipcMain.handle(IpcChannel.Agent_RenameThread, async (_e, rawPayload: unknown) => {
    const { threadId, title } = parseOrThrow(
      renameThreadPayloadSchema,
      rawPayload,
      'renameThread payload'
    );
    requireSession(state);
    await client.sessionRenameThread(state.sessionId!, threadId, title);
    return { renamed: true };
  });

  ipcMain.handle(IpcChannel.Agent_GetMessages, async (_e, rawPayload: unknown) => {
    const { threadId, limit } = parseOrThrow(
      getMessagesPayloadSchema,
      rawPayload,
      'getMessages payload'
    );
    requireSession(state);
    return client.sessionGetMessages(state.sessionId!, threadId, limit);
  });

  ipcMain.handle(IpcChannel.Agent_SendChat, async (_e, rawPayload: unknown) => {
    const payload = parseOrThrow(sendChatPayloadSchema, rawPayload, 'sendChat payload');
    requireSession(state);
    if (!state.threadId) {
      // First message — auto-create a default thread.
      const t = await client.sessionNewThread(state.sessionId!, undefined);
      state.threadId = t.thread_id;
    }
    const result = await client.chatSend({
      session_id: state.sessionId!,
      thread_id: state.threadId!,
      content: payload.content,
      context: payload.context,
    });
    state.inflightTurn = { turnId: result.turn_id, kind: 'chat' };
    return { turnId: result.turn_id };
  });

  ipcMain.handle(IpcChannel.Agent_CancelTurn, async (_e, rawTurnId: unknown) => {
    const turnId = parseOrThrow(turnIdSchema, rawTurnId, 'cancelTurn turnId');
    await client.turnCancel({ turn_id: turnId });
    return { ok: true } as const;
  });

  ipcMain.handle(IpcChannel.Agent_ConfirmEdit, async (_e, rawParams: unknown): Promise<unknown> => {
    const params: EditConfirmParams = parseOrThrow(
      EditConfirmParamsSchema,
      rawParams,
      'confirmEdit params'
    );
    return await client.editConfirm(params);
  });

  ipcMain.handle(
    IpcChannel.Agent_ResolveEditProposal,
    async (_e, rawParams: unknown): Promise<unknown> => {
      const params = parseOrThrow(
        resolveEditProposalSchema,
        rawParams,
        'resolveEditProposal params'
      );
      try {
        return await editApply.resolve(params);
      } catch (err) {
        logger.error('resolveEditProposal failed', {
          proposalId: params.proposalId,
          error: (err as Error).message,
        });
        throw err;
      }
    }
  );

  ipcMain.handle(IpcChannel.Agent_ConfirmTool, async (_e, rawParams: unknown): Promise<unknown> => {
    const params: ToolConfirmParams = parseOrThrow(
      ToolConfirmParamsSchema,
      rawParams,
      'confirmTool params'
    );
    return await client.toolConfirm(params);
  });

  ipcMain.handle(
    IpcChannel.Agent_ContextFlushResponse,
    (_e, rawPayload: unknown): { ok: true } => {
      const payload = parseOrThrow(
        contextFlushResponseSchema,
        rawPayload,
        'contextFlushResponse payload'
      );
      contextRequest.completeFlush(payload);
      return { ok: true };
    }
  );

  return store;
}

// ----- helpers -----

function requireSession(state: AgentSessionState): void {
  if (!state.sessionId) {
    throw new Error('No active session. Call agent.startProject() first.');
  }
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Build a stable project_id from a workspace path. */
function makeProjectIdFromPath(workspaceRoot: string): string {
  // P1 quick scheme: sha-like derivation from normalized path. Full UUID
  // mapping lives in `ProjectRegistry` (next phase).
  const norm = normalizePath(workspaceRoot).toLowerCase();
  return uuidV4ish(norm);
}

/** Build a metadata_root under userData based on the project id. */
function buildMetadataRootFor(projectId: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require('electron');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path') as typeof import('path');
  const root = path.join(app.getPath('userData'), '.snaca', 'local', 'projects', projectId);
  return root;
}

/**
 * Build the shared-metadata root — used by SNACA for cross-project user-level
 * memory (e.g. global skills, persistent preferences). Lives alongside
 * per-project metadata under `~/.scipen-studio/.snaca/local/shared/`.
 */
function buildSharedMetadataRoot(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require('electron');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path') as typeof import('path');
  return path.join(app.getPath('userData'), '.snaca', 'local', 'shared');
}

/**
 * Lightweight deterministic UUID-shape from any input string. Real
 * `ProjectRegistry` will replace this with a persistent UUID v4.
 */
function uuidV4ish(input: string): string {
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0xdeadbeef >>> 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  const part = (n: number, len: number): string => n.toString(16).padStart(8, '0').slice(0, len);
  return [part(h1, 8), part(h2, 4), '4' + part(h1 ^ h2, 3), '8' + part(h2 ^ h1, 3), part(h1 + h2, 8) + part(h2 - h1, 4)].join('-');
}

/** Render `SnacaConfig` from Studio settings. */
function buildSnacaConfigFromSettings(_config: IConfigManager): SnacaConfig {
  // P1 minimal: read everything from env / hard-defaults. Real Settings UI
  // pulls these out of SecureStorage + config in a later phase.
  return {
    llm: {
      provider: 'deepseek',
      api_key_env: 'SNACA_API_KEY',
      model: process.env.SNACA_MODEL ?? 'deepseek-chat',
      base_url: process.env.SNACA_BASE_URL ?? 'https://api.deepseek.com',
    },
    engine: {},
    approval_mode: 'auto_allow',
  };
}
