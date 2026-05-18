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
import { IpcChannel } from '../../../shared/ipc/channels';
import type { IEditorProtocolClient } from '../services/agent/interfaces/IEditorProtocolClient';
import type {
  ISnacaSidecarService,
  SidecarState,
} from '../services/agent/interfaces/ISnacaSidecarService';
import { EDITOR_PROTOCOL_VERSION } from '../services/agent/protocol/methods';
import type {
  EditConfirmParams,
  SnacaConfig,
  ToolConfirmParams,
} from '../services/agent/protocol/schemas';
import { createLogger } from '../services/LoggerService';
import { DisposableStore } from '../../../shared/utils/lifecycle';
import type { IConfigManager } from '../services/interfaces';

const logger = createLogger('AgentHandlers');

export interface AgentHandlersDeps {
  sidecar: ISnacaSidecarService;
  client: IEditorProtocolClient;
  config: IConfigManager;
}

interface AgentSessionState {
  sessionId: string | null;
  threadId: string | null;
  inflightTurn: { turnId: string; kind: 'chat' | 'inline_edit' | 'composer' } | null;
}

interface StartProjectParams {
  workspaceRoot: string;
  displayName?: string;
  projectType?: 'latex' | 'typst' | 'mixed';
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

export function registerAgentHandlers(deps: AgentHandlersDeps): DisposableStore {
  const { sidecar, client, config } = deps;
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

  // ----- Request handlers -----

  ipcMain.handle(IpcChannel.Agent_GetSidecarState, (): SidecarState => sidecar.state);
  ipcMain.handle(IpcChannel.Agent_GetSessionState, (): AgentSessionState => ({ ...state }));

  ipcMain.handle(IpcChannel.Agent_StartProject, async (_e, params: StartProjectParams) => {
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

    const result = await client.sessionOpen({
      project_id: projectId,
      workspace_root: normalizePath(params.workspaceRoot),
      metadata_root: normalizePath(metadataRoot),
      display_name: params.displayName ?? params.workspaceRoot,
      project_type: params.projectType ?? 'latex',
    });

    state.sessionId = result.session_id;
    state.threadId = result.threads[0]?.thread_id ?? null;

    return {
      sessionId: result.session_id,
      threadId: state.threadId,
      threads: result.threads,
    };
  });

  ipcMain.handle(IpcChannel.Agent_NewThread, async (_e, title?: string) => {
    requireSession(state);
    const result = await client.sessionNewThread(state.sessionId!, title);
    state.threadId = result.thread_id;
    return { threadId: result.thread_id, title: result.title };
  });

  ipcMain.handle(IpcChannel.Agent_SwitchThread, async (_e, threadId: string) => {
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

  ipcMain.handle(
    IpcChannel.Agent_SendChat,
    async (_e, params: { content: string; context: Record<string, unknown> }) => {
      requireSession(state);
      if (!state.threadId) {
        // First message — auto-create a default thread.
        const t = await client.sessionNewThread(state.sessionId!, undefined);
        state.threadId = t.thread_id;
      }
      const result = await client.chatSend({
        session_id: state.sessionId!,
        thread_id: state.threadId!,
        content: params.content,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        context: (params.context ?? {}) as any,
      });
      state.inflightTurn = { turnId: result.turn_id, kind: 'chat' };
      return { turnId: result.turn_id };
    }
  );

  ipcMain.handle(IpcChannel.Agent_CancelTurn, async (_e, turnId: string) => {
    await client.turnCancel({ turn_id: turnId });
    return { ok: true } as const;
  });

  ipcMain.handle(IpcChannel.Agent_ConfirmEdit, async (_e, params: EditConfirmParams) => {
    return await client.editConfirm(params);
  });

  ipcMain.handle(IpcChannel.Agent_ConfirmTool, async (_e, params: ToolConfirmParams) => {
    return await client.toolConfirm(params);
  });

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
