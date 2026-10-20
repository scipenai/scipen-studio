/**
 * @file AgentClientService - thin renderer-side wrapper around `window.electron.agent`.
 *
 * Centralises type-safe access so React components don't sprinkle
 * `window.electron.agent.*` everywhere. The underlying surface is the
 * preload `agentApi` (see `src/preload/api/agent.ts`).
 *
 * Type strategy: we keep the wire types local to renderer to avoid
 * cross-boundary `import type` paths (renderer tsconfig doesn't include
 * src/main or src/preload). The wire shapes mirror `editor-protocol`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============ Wire types (snake_case, mirror protocol) ============

export interface Position {
  line: number;
  column: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export type ProjectType = 'latex' | 'typst' | 'mixed';

export interface ActiveFileContext {
  path: string;
  language: string;
  cursor?: Position;
  visible_range?: { start_line: number; end_line: number };
  selection?: { range: Range; text: string };
  dirty?: boolean;
}

export interface OpenTab {
  path: string;
  dirty: boolean;
}

export interface ProjectMeta {
  type: ProjectType;
  main_file?: string;
  engine?: string;
}

export interface DiagnosticItem {
  path: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  range?: Range;
}

export type Mention =
  | { kind: 'file'; path: string; inline_content?: string }
  | { kind: 'folder'; path: string }
  | { kind: 'symbol'; path: string; name: string; range: Range }
  | { kind: 'selection'; path: string; range: Range; text: string }
  | { kind: 'url'; url: string; content?: string };

export interface RecentEdit {
  path: string;
  ts: string;
  summary: string;
}

export interface ChatContext {
  active_file?: ActiveFileContext;
  open_tabs?: OpenTab[];
  recent_edits?: RecentEdit[];
  mentions?: Mention[];
  diagnostics?: DiagnosticItem[];
  project?: ProjectMeta;
  /** Free-form markdown intel summary; rendered into LLM system prompt. */
  project_intel?: string;
  /** itemKey of the Zotero paper currently open in the right pane (opened via Ctrl+Click on \cite). */
  active_zotero_item?: string;
  /** Heading of the section the markdown preview is currently scrolled to (scroll-spy). */
  markdown_section?: string;
}

export interface ThreadSummary {
  thread_id: string;
  title: string;
  created_at: string;
  last_active_at: string;
  turn_count: number;
}

export interface ThreadMessageDTO {
  role: 'user' | 'assistant' | 'system';
  text: string;
  ts: string;
  /** Turn that produced this message — used to re-attach thinking trace
   *  / tool calls / edit proposals from the local IndexedDB cache. */
  turn_id?: string;
}

export interface AgentClientStartProjectResult {
  sessionId: string;
  threadId: string | null;
  threads: ThreadSummary[];
}

// ============ Sidecar state mirror ============

/**
 * Renderer-local mirror of main's `SidecarFailureReason`.
 * @see src/main/services/agent/interfaces/ISnacaSidecarService.ts
 */
export type AgentSidecarFailureReason = 'binary-missing' | 'crash';

/**
 * Renderer-local mirror of main's `SidecarState`. Duplicated rather than
 * imported because the renderer tsconfig excludes `src/main`; keep both in
 * sync when the state machine gains a variant.
 */
export type AgentSidecarState =
  | { kind: 'stopped' }
  | { kind: 'starting'; pid?: number }
  | { kind: 'running'; pid: number; startedAt: number }
  | { kind: 'crashed'; lastError: string; retryAt: number; attempt: number }
  | {
      kind: 'failed';
      reason: AgentSidecarFailureReason;
      /** Human-readable cause; for `crash` this includes the stderr tail. */
      lastError: string;
      attempts: number;
      failedAt: number;
    }
  | { kind: 'stopping' };

/**
 * Shallow equality over the flat state variants. Lets the cache keep its
 * previous reference when a transition re-delivers an equivalent value —
 * the initial fetch and the first push routinely carry the same state, and
 * main re-fires `stopped` on some shutdown paths.
 */
function isSameSidecarState(a: AgentSidecarState | null, b: AgentSidecarState): boolean {
  if (a === null || a.kind !== b.kind) return false;
  const prev = a as Record<string, unknown>;
  const next = b as Record<string, unknown>;
  const keys = Object.keys(next);
  if (Object.keys(prev).length !== keys.length) return false;
  return keys.every((k) => prev[k] === next[k]);
}

// ============ Implementation ============

class AgentClientServiceImpl {
  private get api(): any {
    const electron = (window as unknown as { electron?: { agent?: any } }).electron;
    if (!electron?.agent) {
      throw new Error(
        'window.electron.agent is not available — preload bridge missing or not yet loaded'
      );
    }
    return electron.agent;
  }

  // ---- state queries ----

  getSidecarState() {
    return this.api.getSidecarState();
  }

  getSessionState() {
    return this.api.getSessionState();
  }

  // ---- sidecar state mirror (useSyncExternalStore backing store) ----

  /**
   * Last known sidecar state, held as a single reference that is replaced
   * only on a real transition. `useSyncExternalStore` compares snapshots by
   * identity, so handing back a fresh object per read would re-render until
   * React bails with "Maximum update depth exceeded".
   */
  private sidecarState: AgentSidecarState | null = null;
  private readonly sidecarListeners = new Set<() => void>();
  private sidecarUnsubscribe: (() => void) | null = null;
  /**
   * Bumped on every push. The initial fetch remembers the epoch it started
   * at and discards its result if a push landed meanwhile — otherwise a slow
   * `getSidecarState()` round-trip could clobber a newer state.
   */
  private sidecarEpoch = 0;

  /**
   * Subscribe to sidecar transitions. The bridge listener is attached with
   * the first subscriber and detached with the last, so N consumers share
   * one IPC listener. The cache survives a detach and is refreshed on the
   * next attach, so a re-mounting consumer shows the last known state
   * instead of flashing `null`.
   */
  subscribeSidecarState(onChange: () => void): () => void {
    this.sidecarListeners.add(onChange);
    if (this.sidecarListeners.size === 1) this.attachSidecarState();
    return () => {
      this.sidecarListeners.delete(onChange);
      if (this.sidecarListeners.size === 0) this.detachSidecarState();
    };
  }

  /** Cached snapshot; `null` until the first fetch or push resolves. */
  getSidecarStateSync(): AgentSidecarState | null {
    return this.sidecarState;
  }

  /**
   * Never throws: this runs inside `useSyncExternalStore`'s subscribe, where
   * an exception would tear down the consuming tree. A missing preload
   * bridge degrades to a permanently `null` snapshot instead.
   */
  private attachSidecarState(): void {
    try {
      this.sidecarUnsubscribe = this.api.onSidecarStateChange((s: AgentSidecarState) => {
        this.sidecarEpoch++;
        this.setSidecarState(s);
      });
    } catch {
      this.sidecarUnsubscribe = null;
    }

    const startedAtEpoch = this.sidecarEpoch;
    void (async () => {
      try {
        const state: AgentSidecarState = await this.api.getSidecarState();
        // A push already delivered a newer state — drop this stale read.
        if (this.sidecarEpoch !== startedAtEpoch) return;
        this.setSidecarState(state);
      } catch {
        // Bridge not ready or main threw: keep the cache and wait for a push.
      }
    })();
  }

  private detachSidecarState(): void {
    this.sidecarUnsubscribe?.();
    this.sidecarUnsubscribe = null;
  }

  private setSidecarState(next: AgentSidecarState): void {
    if (!next || isSameSidecarState(this.sidecarState, next)) return;
    this.sidecarState = next;
    for (const notify of this.sidecarListeners) notify();
  }

  // ---- lifecycle ----

  async startProject(
    workspaceRoot: string,
    displayName?: string
  ): Promise<AgentClientStartProjectResult> {
    const res = await this.api.startProject({
      workspaceRoot,
      displayName,
      projectType: 'latex',
    });
    return {
      sessionId: res.sessionId,
      threadId: res.threadId ?? null,
      threads: res.threads ?? [],
    };
  }

  newThread(title?: string): Promise<{ threadId: string; title: string }> {
    return this.api.newThread(title);
  }

  switchThread(threadId: string): Promise<{ switched: true }> {
    return this.api.switchThread(threadId);
  }

  listThreads(): Promise<ThreadSummary[]> {
    return this.api.listThreads();
  }

  /**
   * Delete a thread. Main side auto-falls-back to the most-recently-active
   * remaining thread (or spawns a fresh one if none remain) and returns the
   * id of whatever is active after the delete.
   */
  deleteThread(threadId: string): Promise<{ deleted: boolean; activeThreadId: string }> {
    return this.api.deleteThread(threadId);
  }

  renameThread(threadId: string, title: string): Promise<{ renamed: boolean }> {
    return this.api.renameThread(threadId, title);
  }

  /**
   * Fetch the rendered history of a thread (P4-A: in-memory in SNACA, so a
   * sidecar restart clears it; persistence lands in P4-B).
   */
  getMessages(
    threadId: string,
    limit?: number
  ): Promise<{ messages: ThreadMessageDTO[]; total: number }> {
    return this.api.getMessages(threadId, limit);
  }

  // ---- chat ----

  async sendChat(content: string, context: ChatContext = {}): Promise<{ turnId: string }> {
    return this.api.sendChat({ content, context });
  }

  async startComposer(
    instruction: string,
    context: ChatContext = {},
    mode: 'plan_first' | 'immediate' = 'plan_first',
    scope?: { paths: string[] }
  ): Promise<{ turnId: string }> {
    return this.api.startComposer({ instruction, context, mode, scope });
  }

  confirmPlan(turnId: string, decision: 'accept' | 'reject' | 'modify'): Promise<{ ok: boolean }> {
    return this.api.confirmPlan({ turnId, decision });
  }

  cancelTurn(turnId: string): Promise<{ ok: true }> {
    return this.api.cancelTurn(turnId);
  }

  confirmEdit(params: unknown): Promise<unknown> {
    return this.api.confirmEdit(params);
  }

  confirmTool(params: {
    toolCallId: string;
    decision: 'allow' | 'deny' | 'allow_always' | 'deny_always';
  }): Promise<unknown> {
    return this.api.confirmTool(params);
  }

  /**
   * host_applies resolution: tell main to apply (or reject) the proposal on
   * disk and forward `editConfirm` to SNACA. See `AgentEditApplyService`.
   */
  resolveEditProposal(params: {
    proposalId: string;
    decision: 'accept' | 'reject' | 'accept_partial';
    perHunk?: Array<{ hunkId: string; decision: 'accept' | 'reject' }>;
    workspaceRoot?: string;
  }): Promise<{
    applied: boolean;
    appliedHash?: string;
    errors?: Array<{ hunkId: string; message: string }>;
  }> {
    return this.api.resolveEditProposal(params);
  }

  /**
   * Reverse-RPC reply: notify main that the renderer has flushed the
   * requested dirty tabs. Resolves the pending `flush_unsaved` reverse-RPC
   * back to SNACA. Pass the actual list of files written — if there was
   * nothing dirty, pass `[]` (still required so main can resolve).
   */
  respondContextFlush(payload: {
    requestId: string;
    flushedFiles: string[];
  }): Promise<{ ok: true }> {
    return this.api.respondContextFlush(payload);
  }

  respondContextZotero(payload: {
    requestId: string;
    ok: boolean;
    data?: unknown;
    error?: string;
  }): Promise<{ ok: true }> {
    return this.api.respondContextZotero(payload);
  }

  /** AskUserQuestion card request (main → renderer). */
  onUserQuestionRequest(cb: (e: any) => void): () => void {
    return this.api.onUserQuestionRequest(cb);
  }

  /** Reply with the user's selection once they submit the card. */
  respondUserQuestion(payload: {
    requestId: string;
    ok: boolean;
    answers?: {
      answers: Array<{
        question_id: string;
        selected_option_ids: string[];
        other_text?: string;
        notes?: string;
      }>;
      user_id?: string;
      decided_at?: string;
    };
    error?: string;
  }): Promise<{ ok: true }> {
    return this.api.respondUserQuestion(payload);
  }

  // ---- Memory viewer ----

  memoryList(scope?: 'user' | 'feedback' | 'project' | 'reference'): Promise<any> {
    return this.api.memoryList(scope);
  }

  memoryGet(scope: 'user' | 'feedback' | 'project' | 'reference', name: string): Promise<any> {
    return this.api.memoryGet(scope, name);
  }

  memoryWrite(
    scope: 'user' | 'feedback' | 'project' | 'reference',
    name: string,
    content: string
  ): Promise<any> {
    return this.api.memoryWrite(scope, name, content);
  }

  memoryDelete(scope: 'user' | 'feedback' | 'project' | 'reference', name: string): Promise<any> {
    return this.api.memoryDelete(scope, name);
  }

  memoryReveal(scope?: 'user' | 'feedback' | 'project' | 'reference', name?: string): Promise<any> {
    return this.api.memoryReveal(scope, name);
  }

  // ---- Skills viewer (read-only) ----

  skillsList(): Promise<any> {
    return this.api.skillsList();
  }

  skillsGet(name: string): Promise<any> {
    return this.api.skillsGet(name);
  }

  skillsReload(): Promise<any> {
    return this.api.skillsReload();
  }

  openMemoryViewer(initialTab?: 'memory' | 'skills'): Promise<number> {
    return this.api.openMemoryViewer(initialTab);
  }

  // ---- event subscriptions (return unsubscribe fn) ----

  onTurnDelta(cb: (e: any) => void): () => void {
    return this.api.onTurnDelta(cb);
  }
  onSidecarStateChange(cb: (e: any) => void): () => void {
    return this.api.onSidecarStateChange(cb);
  }
  onUsageUpdate(cb: (e: any) => void): () => void {
    return this.api.onUsageUpdate(cb);
  }
  onError(cb: (e: any) => void): () => void {
    return this.api.onError(cb);
  }
  onEditPropose(cb: (e: any) => void): () => void {
    return this.api.onEditPropose(cb);
  }
  onEditProposeDelta(cb: (e: any) => void): () => void {
    return this.api.onEditProposeDelta(cb);
  }
  onEditProposeComplete(cb: (e: any) => void): () => void {
    return this.api.onEditProposeComplete(cb);
  }
  onPlanUpdate(cb: (e: any) => void): () => void {
    return this.api.onPlanUpdate(cb);
  }
  onToolApprovalRequest(cb: (e: any) => void): () => void {
    return this.api.onToolApprovalRequest(cb);
  }
  onMemoryUpdated(cb: (e: any) => void): () => void {
    return this.api.onMemoryUpdated(cb);
  }
  onLog(cb: (e: any) => void): () => void {
    return this.api.onLog(cb);
  }
  onEditApplied(
    cb: (e: {
      proposalId: string;
      file: string;
      content: string;
      appliedHash: string;
      mtimeMs: number;
    }) => void
  ): () => void {
    return this.api.onEditApplied(cb);
  }
  onContextFlushRequest(cb: (e: { requestId: string; paths?: string[] }) => void): () => void {
    return this.api.onContextFlushRequest(cb);
  }

  onContextZoteroRequest(
    cb: (e: {
      requestId: string;
      kind: 'zotero_search' | 'zotero_lookup' | 'zotero_annotations';
      params: Record<string, unknown>;
    }) => void
  ): () => void {
    return this.api.onContextZoteroRequest(cb);
  }
}

export const agentClient = new AgentClientServiceImpl();
