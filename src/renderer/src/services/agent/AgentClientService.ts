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
  onContextFlushRequest(
    cb: (e: { requestId: string; paths?: string[] }) => void
  ): () => void {
    return this.api.onContextFlushRequest(cb);
  }
}

export const agentClient = new AgentClientServiceImpl();
