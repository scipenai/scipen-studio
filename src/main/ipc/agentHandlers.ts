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
import { ConfigKeys } from '../../../shared/types/config-keys';
import type {
  AIProviderDTO,
  ModelSelection,
} from '../../../shared/ipc/types';
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
  type LlmProvider,
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

/** Last successful startProject input — used to silently re-open a session
 *  after `reloadSidecar` so the renderer never sees "No active session". */
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

  /** Last successful startProject input, kept so reloadSidecar can
   *  silently re-open a session against the same project after the
   *  sidecar comes back up. */
  let lastStartParams: StartProjectParams | null = null;

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

  // ----- AI config → sidecar restart -----
  //
  // When the user changes the selected provider, api key, or model, the
  // running sidecar still holds the OLD `SnacaConfig` from its `init`
  // call. Restart it and clear the session so the next `startProject`
  // re-issues `init` with the fresh settings.
  let restartTimer: NodeJS.Timeout | null = null;
  const scheduleSidecarReload = (): void => {
    if (restartTimer) return;
    // Debounce: settings UIs typically fire several writes back-to-back.
    restartTimer = setTimeout(() => {
      restartTimer = null;
      void reloadSidecar();
    }, 300);
  };
  /**
   * Open (or re-open) a session against `params` and write the result
   * into `state`. Closes any prior session first. Caller owns retry —
   * this function throws on hard failures so they surface in IPC.
   */
  const openSessionFor = async (
    params: StartProjectParams
  ): Promise<{ sessionId: string; threadId: string; threads: unknown[] }> => {
    await initIfNeeded();
    if (state.sessionId) {
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
    state.threadId = result.active_thread_id;
    lastStartParams = params;
    return {
      sessionId: result.session_id,
      threadId: result.active_thread_id,
      threads: result.threads,
    };
  };

  /**
   * Drop the in-process session view; handlers will rebuild it lazily
   * via `ensureSessionReady` the next time the renderer issues a request.
   * Don't re-open here — that couples the reload event to a specific
   * recovery moment; the lazy path covers reload, sidecar crash, and
   * any other future "session lost" path with one mechanism.
   */
  const reloadSidecar = async (): Promise<void> => {
    state.sessionId = null;
    state.threadId = null;
    state.inflightTurn = null;
    initPromise = null;
    if (!sidecar.isRunning()) {
      logger.debug('AI config changed; sidecar not running, skipping restart');
      return;
    }
    try {
      await sidecar.restart();
      logger.info('AI config changed; sidecar restarted');
    } catch (err) {
      logger.error('sidecar restart after AI config change failed', {
        error: (err as Error).message,
      });
    }
  };

  /**
   * Make sure `state.sessionId` is current before executing a session-scoped
   * handler. The session can disappear for several reasons:
   *   - AI config change → sidecar restart (`reloadSidecar`)
   *   - sidecar crashed and auto-recovered with a different pid
   *   - explicit shutdown / future eviction policies
   *
   * Rather than push a "session lost" event to the renderer and ask it to
   * re-call `startProject`, we silently re-open using the parameters of the
   * last successful start. The renderer never sees the gap.
   */
  const ensureSessionReady = async (): Promise<void> => {
    if (state.sessionId) return;
    if (!lastStartParams) {
      throw new Error('No active session. Call agent.startProject() first.');
    }
    logger.info('session missing; auto re-opening', {
      workspaceRoot: lastStartParams.workspaceRoot,
    });
    await openSessionFor(lastStartParams);
  };
  store.add({ dispose: config.subscribe(ConfigKeys.AIProviders, scheduleSidecarReload) });
  store.add({
    dispose: config.subscribe(ConfigKeys.AISelectedModels, scheduleSidecarReload),
  });
  store.add({
    dispose: () => {
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
    },
  });
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
    return await openSessionFor(params);
  });

  ipcMain.handle(IpcChannel.Agent_NewThread, async (_e, rawTitle: unknown) => {
    const title = parseOrThrow(threadTitleSchema, rawTitle, 'newThread title');
    await ensureSessionReady();
    const result = await client.sessionNewThread(state.sessionId!, title);
    state.threadId = result.thread_id;
    return { threadId: result.thread_id, title: result.title };
  });

  ipcMain.handle(IpcChannel.Agent_SwitchThread, async (_e, rawThreadId: unknown) => {
    const threadId = parseOrThrow(threadIdSchema, rawThreadId, 'switchThread threadId');
    await ensureSessionReady();
    await client.sessionSwitchThread(state.sessionId!, threadId);
    state.threadId = threadId;
    return { switched: true };
  });

  ipcMain.handle(IpcChannel.Agent_ListThreads, async () => {
    await ensureSessionReady();
    const result = await client.sessionListThreads(state.sessionId!);
    return result.threads;
  });

  ipcMain.handle(IpcChannel.Agent_DeleteThread, async (_e, rawThreadId: unknown) => {
    const threadId = parseOrThrow(threadIdSchema, rawThreadId, 'deleteThread threadId');
    await ensureSessionReady();
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
    await ensureSessionReady();
    await client.sessionRenameThread(state.sessionId!, threadId, title);
    return { renamed: true };
  });

  ipcMain.handle(IpcChannel.Agent_GetMessages, async (_e, rawPayload: unknown) => {
    const { threadId, limit } = parseOrThrow(
      getMessagesPayloadSchema,
      rawPayload,
      'getMessages payload'
    );
    await ensureSessionReady();
    return client.sessionGetMessages(state.sessionId!, threadId, limit);
  });

  ipcMain.handle(IpcChannel.Agent_SendChat, async (_e, rawPayload: unknown) => {
    const payload = parseOrThrow(sendChatPayloadSchema, rawPayload, 'sendChat payload');
    await ensureSessionReady();
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

/** Wire name for SNACA's api-key env variable. */
const SNACA_API_KEY_ENV = 'SNACA_API_KEY';

/** Render `SnacaConfig` from Studio settings (provider + selected chat model). */
export function buildSnacaConfigFromSettings(config: IConfigManager): SnacaConfig {
  const resolved = resolveChatProvider(config);
  return {
    llm: {
      // Protocol contract: only the env variable NAME crosses the wire.
      // The sidecar reads the actual key from its spawned process env.
      provider: resolved?.snacaProvider ?? envFallbackProvider(),
      api_key_env: SNACA_API_KEY_ENV,
      model: resolved?.modelId ?? process.env.SNACA_MODEL ?? 'deepseek-chat',
      base_url: resolved?.baseUrl ?? process.env.SNACA_BASE_URL ?? 'https://api.deepseek.com',
    },
    engine: {},
    approval_mode: 'auto_allow',
  };
}

/**
 * Build the env injected into the spawned sidecar. `SNACA_API_KEY` is
 * sourced from the selected chat provider; `process.env.SNACA_API_KEY` is
 * a developer-only fallback.
 */
export function buildSnacaSidecarEnv(config: IConfigManager): NodeJS.ProcessEnv {
  const resolved = resolveChatProvider(config);
  const apiKey = resolved?.apiKey || process.env.SNACA_API_KEY || '';
  return {
    [SNACA_API_KEY_ENV]: apiKey,
    RUST_LOG: process.env.SNACA_LOG ?? 'snaca_editor=info,info',
  };
}

interface ResolvedChatProvider {
  snacaProvider: LlmProvider;
  modelId: string;
  baseUrl?: string;
  apiKey: string;
}

/** Look up the chat-selected provider/model out of the AI config DTO. */
function resolveChatProvider(config: IConfigManager): ResolvedChatProvider | null {
  let ai;
  try {
    ai = config.getFullAIConfig();
  } catch {
    return null;
  }
  // Prefer the explicit chat selection; if absent, fall back to the
  // completion selection (the Settings UI keeps them aligned, but legacy
  // configs may only carry `completion`). Same providerId either way →
  // same credentials.
  const selection: ModelSelection | null =
    ai.selectedModels.chat ?? ai.selectedModels.completion;
  if (!selection) return null;

  const providers: AIProviderDTO[] = ai.providers;
  const provider = providers.find((p) => p.id === selection.providerId && p.enabled);
  if (!provider) return null;
  if (!selection.modelId) return null;

  return {
    snacaProvider: mapProviderIdToSnaca(provider.id),
    modelId: selection.modelId,
    baseUrl: provider.apiHost?.trim() || undefined,
    apiKey: provider.apiKey ?? '',
  };
}

/**
 * Studio's ProviderId namespace is wider than SNACA's LlmProvider enum.
 * Anthropic gets the native Messages client; everything else goes through
 * the OpenAI-compatible client. Users pick the actual upstream by setting
 * the base URL (e.g. `https://api.deepseek.com` for DeepSeek OpenAI-compat,
 * `https://api.deepseek.com/anthropic` for DeepSeek's Anthropic gateway).
 */
function mapProviderIdToSnaca(providerId: string): LlmProvider {
  return providerId === 'anthropic' ? 'anthropic' : 'openai_compatible';
}

/**
 * Choose a sensible env-only default when the user has not configured a
 * chat provider yet. Falls back to OpenAI-compatible (the broadest fit)
 * unless `SNACA_BASE_URL` clearly points at an Anthropic endpoint.
 */
function envFallbackProvider(): LlmProvider {
  const base = (process.env.SNACA_BASE_URL ?? '').toLowerCase();
  if (base.includes('anthropic')) return 'anthropic';
  return 'openai_compatible';
}
