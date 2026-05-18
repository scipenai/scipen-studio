/**
 * @file AgentClientService - thin renderer-side wrapper around `window.api.agent`.
 *
 * Centralises type-safe access so React components don't sprinkle
 * `window.api.agent.*` everywhere. Also tracks the *current* turn id
 * locally as a convenience (UI usually wants "the last turn I started").
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface AgentClientStartProjectResult {
  sessionId: string;
  threadId: string | null;
  threads: Array<{
    thread_id: string;
    title: string;
    created_at: string;
    last_active_at: string;
    turn_count: number;
  }>;
}

/** Convenience-shaped chat context, mirrors `ChatContext` on the main side. */
export type ChatContextDTO = Record<string, unknown>;

class AgentClientServiceImpl {
  private get api() {
    // window.api typings come from `electron.d.ts` (regenerated when preload
    // surface changes). Cast is intentional — keeps this module
    // self-contained against the global types file.
    return (window as unknown as { api: { agent: any } }).api.agent;
  }

  // ---- state queries ----

  getSidecarState() {
    return this.api.getSidecarState();
  }

  getSessionState() {
    return this.api.getSessionState();
  }

  // ---- lifecycle ----

  async startProject(workspaceRoot: string, displayName?: string): Promise<AgentClientStartProjectResult> {
    return this.api.startProject({ workspaceRoot, displayName, projectType: 'latex' });
  }

  newThread(title?: string): Promise<{ threadId: string; title: string }> {
    return this.api.newThread(title);
  }

  switchThread(threadId: string): Promise<{ switched: true }> {
    return this.api.switchThread(threadId);
  }

  listThreads() {
    return this.api.listThreads();
  }

  // ---- chat ----

  async sendChat(content: string, context: ChatContextDTO = {}): Promise<{ turnId: string }> {
    return this.api.sendChat({ content, context });
  }

  cancelTurn(turnId: string): Promise<{ ok: true }> {
    return this.api.cancelTurn(turnId);
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
  onPlanUpdate(cb: (e: any) => void): () => void {
    return this.api.onPlanUpdate(cb);
  }
}

export const agentClient = new AgentClientServiceImpl();
