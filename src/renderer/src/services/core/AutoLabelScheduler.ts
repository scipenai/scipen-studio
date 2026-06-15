/**
 * @file AutoLabelScheduler - background timer that drops a `kind:'auto'`
 *   snapshot into the history every N hours.
 *
 * Renderer-side because it needs `EditorService.tabs` + `ProjectRuntimeContext`
 * to know what to snapshot, both of which only live here. Main process is
 * unaware of which files are open. The cadence is deliberately coarse (6h
 * default) so the auto-label list does not drown the user; the user-driven
 * manual label is still the primary entry. Skips when no project / no tabs.
 */

import { api } from '../../api';
import { historyProjectIdOf } from '../../utils/historyProjectId';
import { createLogger } from '../LogService';
import { getCompileServiceAsync } from './CompileService';
import { getEditorService, getProjectRuntimeContext } from './ServiceRegistry';

const logger = createLogger('AutoLabelScheduler');

export interface AutoLabelSchedulerOptions {
  /** Snapshot cadence in ms. Default 6 hours. Set to 0 to disable. */
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Throttle two milestone-style auto-labels back-to-back. A user who triggers
 * five compiles in a minute doesn't want five labels in their browse list.
 */
const MILESTONE_MIN_GAP_MS = 5 * 60 * 1000;

class AutoLabelScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRunAtByProject = new Map<string, number>();
  private lastMilestoneAt = 0;
  private compileDispose: (() => void) | null = null;
  private running = false;

  start(opts: AutoLabelSchedulerOptions = {}): void {
    this.stop();
    const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (interval > 0) {
      this.timer = setInterval(() => void this.tick({ kind: 'auto' }), interval);
      if (typeof this.timer.unref === 'function') this.timer.unref();
    }
    // Subscribe to compile success events — async because the compile service
    // is lazy-loaded.
    void this.subscribeToCompile();
    logger.info('AutoLabelScheduler started', { intervalMs: interval });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.compileDispose) {
      this.compileDispose();
      this.compileDispose = null;
    }
  }

  private async subscribeToCompile(): Promise<void> {
    try {
      const compile = await getCompileServiceAsync();
      const sub = compile.onDidFinishCompile((result) => {
        if (!result.success) return;
        const now = Date.now();
        if (now - this.lastMilestoneAt < MILESTONE_MIN_GAP_MS) return;
        this.lastMilestoneAt = now;
        void this.tick({ kind: 'milestone' });
      });
      this.compileDispose = () => sub.dispose();
    } catch (err) {
      logger.warn('compile subscription failed', { error: (err as Error).message });
    }
  }

  /** Force a tick immediately. Tests / "snapshot now" shortcuts use this. */
  async runOnce(): Promise<{ ok: boolean; reason?: string }> {
    return this.tick({ kind: 'auto' });
  }

  private async tick(opts: {
    kind: 'auto' | 'milestone';
  }): Promise<{ ok: boolean; reason?: string }> {
    if (this.running) return { ok: false, reason: 'busy' };
    this.running = true;
    try {
      const projectId = historyProjectIdOf(getProjectRuntimeContext().rootPath);
      if (!projectId) return { ok: false, reason: 'no-project' };
      const tabs = getEditorService().tabs;
      if (tabs.length === 0) return { ok: false, reason: 'no-tabs' };

      const encoder = new TextEncoder();
      const files: Array<{ fileId: string; blobHashHex: string; version: number }> = [];
      for (const tab of tabs) {
        const fileId = tab._id ?? tab.path;
        const bytes = encoder.encode(tab.content);
        const result = await api.history.putBlob({ projectId, bytes });
        files.push({ fileId, blobHashHex: result.hashHex, version: 0 });
      }
      const now = new Date();
      const stamp = now.toISOString().slice(0, 16).replace('T', ' ');
      const name = opts.kind === 'milestone' ? `Compile OK: ${stamp}` : `Auto: ${stamp}`;
      await api.history.createLabel({
        projectId,
        name,
        kind: opts.kind,
        createdBy: opts.kind === 'milestone' ? 'compile' : 'auto',
        files,
      });
      this.lastRunAtByProject.set(projectId, Date.now());
      logger.info('label created', { projectId, name, kind: opts.kind, files: files.length });
      return { ok: true };
    } catch (err) {
      logger.warn('label tick failed', { error: (err as Error).message });
      return { ok: false, reason: (err as Error).message };
    } finally {
      this.running = false;
    }
  }
}

export const autoLabelScheduler = new AutoLabelScheduler();
