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

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'path';
import { z } from 'zod';
import { IpcChannel } from '../../../shared/ipc/channels';
import { ConfigKeys } from '../../../shared/types/config-keys';
import type { AIProviderDTO, ModelSelection } from '../../../shared/ipc/types';
import { AGENT_NOT_CONFIGURED_MARKER } from '../../../shared/ipc/types';
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
  type ComposerStartParams,
  type EditConfirmParams,
  type LlmProvider,
  type PlanConfirmParams,
  McpServerConfigSchema,
  type McpServerConfig,
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

const startComposerPayloadSchema = z.object({
  instruction: z.string().min(1).max(50_000),
  context: ChatContextSchema,
  mode: z.enum(['plan_first', 'immediate']).default('plan_first'),
  scope: z.object({ paths: z.array(z.string().max(4096)).max(256) }).optional(),
});

const confirmPlanPayloadSchema = z.object({
  turnId: z.string().min(1).max(128),
  decision: z.enum(['accept', 'reject', 'modify']),
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

const contextZoteroResponseSchema = z.object({
  requestId: z.string().min(1).max(128),
  ok: z.boolean(),
  // Per-kind shape — validated structurally inside the renderer
  // responder before this point. We accept opaque data here and let
  // ContextRequestService normalize it before sending to SNACA.
  data: z.unknown().optional(),
  error: z.string().max(2048).optional(),
});

const contextQuestionResponseSchema = z.object({
  requestId: z.string().min(1).max(128),
  ok: z.boolean(),
  // Wire `QuestionAnswers` shape; ContextRequestService.shapeQuestionPayload
  // normalizes it (fills defaults) before it reaches SNACA.
  answers: z.unknown().optional(),
  error: z.string().max(2048).optional(),
});

// Renderer-side (camelCase) shapes for tool/edit confirm; the wire
// schemas in protocol/schemas.ts are snake_case and only used right
// before forwarding to the SNACA client.
const confirmToolPayloadSchema = z.object({
  toolCallId: z.string().min(1).max(128),
  decision: z.enum(['allow', 'deny', 'allow_always', 'deny_always']),
});

const confirmEditPayloadSchema = z.object({
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
  modifiedText: z
    .array(
      z.object({
        hunkId: z.string().min(1).max(64),
        newText: z.string(),
      })
    )
    .max(256)
    .optional(),
});

// ----- Memory / Skills viewer (P6-C) -----

const memoryScopeSchema = z.enum(['user', 'feedback', 'project', 'reference']);
const memoryNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_-]+$/, 'name must match [a-z0-9_-]{1,64}');

const memoryListPayloadSchema = z.object({
  scope: memoryScopeSchema.optional(),
});
const memoryGetPayloadSchema = z.object({
  scope: memoryScopeSchema,
  name: memoryNameSchema,
});
const memoryWritePayloadSchema = z.object({
  scope: memoryScopeSchema,
  name: memoryNameSchema,
  content: z.string().max(100_000),
});
const memoryDeletePayloadSchema = z.object({
  scope: memoryScopeSchema,
  name: memoryNameSchema,
});
const memoryRevealPayloadSchema = z.object({
  scope: memoryScopeSchema.optional(),
  name: memoryNameSchema.optional(),
});

const skillsGetPayloadSchema = z.object({
  name: z.string().min(1).max(128),
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
      // "LLM not configured" is the expected initial state, not an error — short-circuit here
      // before spawning the sidecar so we avoid an empty subprocess and don't pollute the log
      // with a doomed 401. The renderer reads this marker and shows the onboarding card (not a
      // red error). The finally clause in `initIfNeeded` clears `initPromise` on failure, so a
      // retry triggered after the user fills in their key can re-run the full init.
      if (!isChatConfigured(config)) {
        throw new Error(AGENT_NOT_CONFIGURED_MARKER);
      }
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
        // Reclaim any pending reverse-RPC entries for this turn so the
        // long-running `ask_user_question` (600 s) doesn't park promises
        // after the turn is over. Cheap no-op for turns without pending
        // entries.
        contextRequest.cancelTurn(e.turn_id);
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
  // Cap on how long we'll wait for an inflight turn before reloading
  // anyway. Without a ceiling, a hung turn would block all future
  // setting changes from taking effect.
  const RELOAD_INFLIGHT_GRACE_MS = 30_000;
  let reloadRequestedAt: number | null = null;
  const scheduleSidecarReload = (): void => {
    if (restartTimer) return;
    if (reloadRequestedAt === null) reloadRequestedAt = Date.now();
    // Debounce: settings UIs typically fire several writes back-to-back.
    // Defer further if a turn is mid-flight — restarting underneath an
    // in-progress LLM round trip would orphan it. The grace window
    // protects against a stuck turn pinning the reload forever.
    const waitForInflight =
      state.inflightTurn !== null && Date.now() - reloadRequestedAt < RELOAD_INFLIGHT_GRACE_MS;
    const delay = waitForInflight ? 800 : 300;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (
        state.inflightTurn !== null &&
        Date.now() - (reloadRequestedAt ?? Date.now()) < RELOAD_INFLIGHT_GRACE_MS
      ) {
        // Inflight turn still running and grace window not exhausted —
        // re-arm the timer instead of restarting now.
        scheduleSidecarReload();
        return;
      }
      reloadRequestedAt = null;
      void reloadSidecar();
    }, delay);
  };

  /**
   * Push a fresh `SnacaConfig` over the live JSON-RPC connection without
   * killing the session. Use for fields SNACA re-reads on each turn
   * (currently only `approval_mode` — LLM model still needs a restart
   * because `Arc<dyn LlmClient>` snapshots are taken per request).
   */
  let reloadConfigTimer: NodeJS.Timeout | null = null;
  const scheduleConfigReload = (): void => {
    if (reloadConfigTimer) return;
    reloadConfigTimer = setTimeout(() => {
      reloadConfigTimer = null;
      if (!isConnected()) return;
      const snacaConfig = buildSnacaConfigFromSettings(config);
      client
        .configReload(snacaConfig)
        .then(() =>
          logger.info('config.reload applied', { approvalMode: snacaConfig.approval_mode })
        )
        .catch((err) => {
          logger.warn('config.reload failed; falling back to sidecar restart', {
            error: (err as Error).message,
          });
          scheduleSidecarReload();
        });
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
  // `approval_mode` is re-read on every chat.send via
  // `inner.snaca_config.approval_mode` (handler.rs:384), so a
  // config.reload (which rewrites that field) is enough — no need to
  // restart the sidecar / kill the session.
  store.add({
    dispose: config.subscribe(ConfigKeys.AgentApprovalMode, scheduleConfigReload),
  });
  // `engine.*` knobs land on `Engine::new` inside `build_session_engine`
  // (session.open path). config.reload can't change an already-built
  // engine instance, so a full sidecar restart is required.
  store.add({
    dispose: config.subscribe(ConfigKeys.AgentEngineConfig, scheduleSidecarReload),
  });
  // MCP server definitions feed into the McpManager that gets baked
  // into Engine's RuntimeToolFactory at session.open. Same restart
  // story as engine.*.
  store.add({
    dispose: config.subscribe(ConfigKeys.AgentMcpServers, scheduleSidecarReload),
  });
  // The Tavily key is injected into the sidecar process env at spawn time
  // (buildSnacaSidecarEnv), so an already-running sidecar won't see a new
  // value until it is respawned — a full restart, like engine.*/mcp.
  store.add({
    dispose: config.subscribe(ConfigKeys.AgentWebSearchApiKey, scheduleSidecarReload),
  });
  store.add({
    dispose: () => {
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      if (reloadConfigTimer) {
        clearTimeout(reloadConfigTimer);
        reloadConfigTimer = null;
      }
    },
  });
  store.add(client.onEditPropose((e) => broadcast(IpcChannel.Agent_EditPropose, e)));
  store.add(client.onEditProposeDelta((e) => broadcast(IpcChannel.Agent_EditProposeDelta, e)));
  store.add(
    client.onEditProposeComplete((e) => broadcast(IpcChannel.Agent_EditProposeComplete, e))
  );
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

  ipcMain.handle(IpcChannel.Agent_StartComposer, async (_e, rawPayload: unknown) => {
    const payload = parseOrThrow(startComposerPayloadSchema, rawPayload, 'startComposer payload');
    await ensureSessionReady();
    if (!state.threadId) {
      const t = await client.sessionNewThread(state.sessionId!, undefined);
      state.threadId = t.thread_id;
    }
    const wire: ComposerStartParams = {
      session_id: state.sessionId!,
      thread_id: state.threadId!,
      instruction: payload.instruction,
      mentions: [],
      context: payload.context,
      mode: payload.mode,
      scope: payload.scope,
    };
    const result = await client.composerStart(wire);
    state.inflightTurn = { turnId: result.turn_id, kind: 'composer' };
    return { turnId: result.turn_id };
  });

  ipcMain.handle(IpcChannel.Agent_ConfirmPlan, async (_e, rawPayload: unknown) => {
    const p = parseOrThrow(confirmPlanPayloadSchema, rawPayload, 'confirmPlan payload');
    const wire: PlanConfirmParams = {
      turn_id: p.turnId,
      decision: p.decision,
    };
    return await client.planConfirm(wire);
  });

  ipcMain.handle(IpcChannel.Agent_CancelTurn, async (_e, rawTurnId: unknown) => {
    const turnId = parseOrThrow(turnIdSchema, rawTurnId, 'cancelTurn turnId');
    // Reclaim pending reverse-RPC entries before notifying SNACA. There's a
    // ~tens-of-ms gap between sending `turn.cancel` and receiving the
    // terminal `turn.delta done`; reclaiming up front closes that window so
    // the user-visible question card disappears immediately on Cancel.
    contextRequest.cancelTurn(turnId);
    await client.turnCancel({ turn_id: turnId });
    return { ok: true } as const;
  });

  ipcMain.handle(IpcChannel.Agent_ConfirmEdit, async (_e, rawParams: unknown): Promise<unknown> => {
    const p = parseOrThrow(confirmEditPayloadSchema, rawParams, 'confirmEdit params');
    const wire: EditConfirmParams = {
      proposal_id: p.proposalId,
      decision: p.decision,
      per_hunk: p.perHunk?.map((h) => ({ hunk_id: h.hunkId, decision: h.decision })),
      modified_text: p.modifiedText?.map((m) => ({ hunk_id: m.hunkId, new_text: m.newText })),
    };
    return await client.editConfirm(wire);
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
    const p = parseOrThrow(confirmToolPayloadSchema, rawParams, 'confirmTool params');
    const wire: ToolConfirmParams = {
      tool_call_id: p.toolCallId,
      decision: p.decision,
    };
    return await client.toolConfirm(wire);
  });

  ipcMain.handle(IpcChannel.Agent_ContextFlushResponse, (_e, rawPayload: unknown): { ok: true } => {
    const payload = parseOrThrow(
      contextFlushResponseSchema,
      rawPayload,
      'contextFlushResponse payload'
    );
    contextRequest.completeFlush(payload);
    return { ok: true };
  });

  ipcMain.handle(
    IpcChannel.Agent_ContextZoteroResponse,
    (_e, rawPayload: unknown): { ok: true } => {
      const payload = parseOrThrow(
        contextZoteroResponseSchema,
        rawPayload,
        'contextZoteroResponse payload'
      );
      contextRequest.completeZotero(payload);
      return { ok: true };
    }
  );

  ipcMain.handle(IpcChannel.Agent_UserQuestionResponse, (_e, rawPayload: unknown): { ok: true } => {
    const payload = parseOrThrow(
      contextQuestionResponseSchema,
      rawPayload,
      'contextQuestionResponse payload'
    );
    contextRequest.completeQuestion(payload);
    return { ok: true };
  });

  // ----- Memory viewer (P6-C) -----
  //
  // All these handlers require `state.sessionId` (set after the
  // first sidecar bootstrap). UI ensures the project is loaded
  // before opening the viewer, so SessionNotFound is degenerate.

  const requireSession = (): string => {
    if (!state.sessionId) {
      throw new Error('No active SNACA session — open a project first.');
    }
    return state.sessionId;
  };

  ipcMain.handle(IpcChannel.Agent_MemoryList, async (_e, rawPayload: unknown) => {
    const p = parseOrThrow(memoryListPayloadSchema, rawPayload ?? {}, 'memoryList payload');
    return await client.memoryList({ session_id: requireSession(), scope: p.scope });
  });

  ipcMain.handle(IpcChannel.Agent_MemoryGet, async (_e, rawPayload: unknown) => {
    const p = parseOrThrow(memoryGetPayloadSchema, rawPayload, 'memoryGet payload');
    return await client.memoryGet({
      session_id: requireSession(),
      scope: p.scope,
      name: p.name,
    });
  });

  ipcMain.handle(IpcChannel.Agent_MemoryWrite, async (_e, rawPayload: unknown) => {
    const p = parseOrThrow(memoryWritePayloadSchema, rawPayload, 'memoryWrite payload');
    return await client.memoryWrite({
      session_id: requireSession(),
      scope: p.scope,
      name: p.name,
      content: p.content,
    });
  });

  ipcMain.handle(IpcChannel.Agent_MemoryDelete, async (_e, rawPayload: unknown) => {
    const p = parseOrThrow(memoryDeletePayloadSchema, rawPayload, 'memoryDelete payload');
    return await client.memoryDelete({
      session_id: requireSession(),
      scope: p.scope,
      name: p.name,
    });
  });

  ipcMain.handle(IpcChannel.Agent_MemoryReveal, async (_e, rawPayload: unknown) => {
    const p = parseOrThrow(memoryRevealPayloadSchema, rawPayload ?? {}, 'memoryReveal payload');
    const result = await client.memoryReveal({
      session_id: requireSession(),
      scope: p.scope,
      name: p.name,
    });
    // Reveal the path in the host's file manager. shell.showItemInFolder
    // wants a file; if the result is a directory, fall back to opening it.
    try {
      const stat = await import('node:fs').then((m) => m.promises.stat(result.path));
      if (stat.isDirectory()) {
        await shell.openPath(result.path);
      } else {
        shell.showItemInFolder(result.path);
      }
    } catch {
      // Path may not exist yet (empty memory tree). No-op, surface via result.
    }
    return result;
  });

  ipcMain.handle(IpcChannel.Agent_SkillsList, async () => {
    return await client.skillsList({ session_id: requireSession() });
  });

  ipcMain.handle(IpcChannel.Agent_SkillsGet, async (_e, rawPayload: unknown) => {
    const p = parseOrThrow(skillsGetPayloadSchema, rawPayload, 'skillsGet payload');
    return await client.skillsGet({ session_id: requireSession(), name: p.name });
  });

  ipcMain.handle(IpcChannel.Agent_SkillsReload, async () => {
    return await client.skillsReload({ session_id: requireSession() });
  });

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
  return [
    part(h1, 8),
    part(h2, 4),
    '4' + part(h1 ^ h2, 3),
    '8' + part(h2 ^ h1, 3),
    part(h1 + h2, 8) + part(h2 - h1, 4),
  ].join('-');
}

/** Wire name for SNACA's api-key env variable. */
const SNACA_API_KEY_ENV = 'SNACA_API_KEY';

/**
 * Read-only skills shipped with the app (SNACA Bundled scope), staged into
 * `resources/skills` at build (see scripts/copy-skills.js). Override via
 * `SNACA_BUNDLED_SKILLS_DIR`. May be absent in dev — SNACA tolerates a missing dir.
 */
function resolveBundledSkillsDir(): string {
  if (process.env.SNACA_BUNDLED_SKILLS_DIR) {
    return process.env.SNACA_BUNDLED_SKILLS_DIR;
  }
  return app.isPackaged
    ? path.join(process.resourcesPath, 'skills')
    : path.join(app.getAppPath(), 'resources', 'skills');
}

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
    engine: readEngineOverrides(config),
    mcp_servers: readMcpServers(config),
    // `interactive` routes file-mutation tools (Edit/Write/MultiEdit)
    // through Studio's Monaco Diff Review and high-risk tools (Bash)
    // through the in-chat approval card. `auto_allow` would let SNACA
    // edit files / run shell commands without any user review — that
    // is a CI / server-side default, not what a desktop user expects;
    // we keep it as the floor and let advanced users opt out via the
    // Agent settings tab.
    approval_mode: readApprovalMode(config),
    bundled_skills_dir: resolveBundledSkillsDir(),
  };
}

/**
 * Read the persisted approval-mode override. Falls back to
 * `interactive` (the safe default) when unset or unrecognised.
 */
function readApprovalMode(config: IConfigManager): 'interactive' | 'auto_allow' | 'auto_deny' {
  const raw = config.get<string | undefined>(ConfigKeys.AgentApprovalMode, undefined);
  if (raw === 'auto_allow' || raw === 'auto_deny' || raw === 'interactive') {
    return raw;
  }
  return 'interactive';
}

/**
 * Read engine overrides persisted under `AgentEngineConfig`. Only fields
 * that pass shape validation are forwarded; everything else falls back
 * to SNACA's model-aware defaults via the empty default `{}`.
 *
 * Stored shape mirrors `EngineConfigSchema` (camelCase to snake_case
 * translation kept out of the renderer since both sides only use the
 * wire form — there is no rendering tier for these advanced knobs).
 */
function readEngineOverrides(config: IConfigManager): Record<string, unknown> {
  const raw = config.get<unknown>(ConfigKeys.AgentEngineConfig, undefined);
  if (!raw || typeof raw !== 'object') return {};
  // Drop nulls / undefineds so SNACA's `default_for(model)` keeps the
  // model-tuned defaults instead of receiving an explicit null.
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      ([, v]) => v !== null && v !== undefined && v !== ''
    )
  );
}

/**
 * Read MCP server definitions from settings and pass them straight
 * through to the wire. Each entry is validated via the protocol
 * `McpServerConfigSchema`; invalid rows are dropped (logged) so a
 * single bad config can't deny init. Returns `undefined` (instead of
 * `[]`) when nothing is configured so the SNACA side sees the field
 * absent — matches the protocol's `Option<Vec<...>>`.
 */
function readMcpServers(config: IConfigManager): McpServerConfig[] | undefined {
  const raw = config.get<unknown>(ConfigKeys.AgentMcpServers, undefined);
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: McpServerConfig[] = [];
  for (const entry of raw) {
    const parsed = McpServerConfigSchema.safeParse(entry);
    if (!parsed.success) {
      logger.warn('skipping invalid mcp server entry', {
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
      continue;
    }
    out.push(parsed.data);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Build the env injected into the spawned sidecar. `SNACA_API_KEY` is
 * sourced from the selected chat provider; `process.env.SNACA_API_KEY` is
 * a developer-only fallback.
 */
export function buildSnacaSidecarEnv(config: IConfigManager): NodeJS.ProcessEnv {
  const resolved = resolveChatProvider(config);
  const apiKey = resolved?.apiKey || process.env.SNACA_API_KEY || '';
  const env: NodeJS.ProcessEnv = {
    [SNACA_API_KEY_ENV]: apiKey,
    RUST_LOG: process.env.SNACA_LOG ?? 'snaca_editor=info,info',
  };
  // WebSearch (Tavily) reads its key from TAVILY_API_KEY. The Settings value
  // wins; `process.env` is a developer-only fallback. Mirrors how the chat
  // api-key is sourced — only the resolved value is injected into the env,
  // never persisted into SnacaConfig.
  const tavilyKey =
    config.get<string | undefined>(ConfigKeys.AgentWebSearchApiKey, undefined)?.trim() ||
    process.env.TAVILY_API_KEY;
  if (tavilyKey) {
    env.TAVILY_API_KEY = tavilyKey;
  }
  return env;
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
  const selection: ModelSelection | null = ai.selectedModels.chat ?? ai.selectedModels.completion;
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
 * Single source of truth: decide whether the chat agent has a usable LLM config.
 *
 * Ready = provider + model selected (`resolveChatProvider` non-null) AND an API key is available.
 * Key resolution mirrors `buildSnacaSidecarEnv` exactly: settings key wins, with
 * `process.env.SNACA_API_KEY` as a developer-only fallback — count env in so we don't
 * misclassify the "only env var, settings empty" developer scenario (renderer can't see env,
 * so this check must live in main, not the front end).
 */
function isChatConfigured(config: IConfigManager): boolean {
  const resolved = resolveChatProvider(config);
  if (!resolved) return false;
  return Boolean(resolved.apiKey?.trim() || process.env.SNACA_API_KEY?.trim());
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
