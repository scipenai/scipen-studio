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
import { createLogger } from '../LogService';
import { getEditorService, getProjectRuntimeContext } from './ServiceRegistry';

const logger = createLogger('AutoLabelScheduler');

export interface AutoLabelSchedulerOptions {
  /** Snapshot cadence in ms. Default 6 hours. Set to 0 to disable. */
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

class AutoLabelScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRunAtByProject = new Map<string, number>();
  private running = false;

  start(opts: AutoLabelSchedulerOptions = {}): void {
    this.stop();
    const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (interval <= 0) return;
    this.timer = setInterval(() => void this.tick(), interval);
    // Best-effort daemon — don't keep the renderer process alive solo on it.
    if (typeof this.timer.unref === 'function') this.timer.unref();
    logger.info('AutoLabelScheduler started', { intervalMs: interval });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Force a tick immediately. Tests / "snapshot now" shortcuts use this. */
  async runOnce(): Promise<{ ok: boolean; reason?: string }> {
    return this.tick();
  }

  private async tick(): Promise<{ ok: boolean; reason?: string }> {
    if (this.running) return { ok: false, reason: 'busy' };
    this.running = true;
    try {
      const projectId = getProjectRuntimeContext().projectId;
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
      const name = `Auto: ${now.toISOString().slice(0, 16).replace('T', ' ')}`;
      await api.history.createLabel({
        projectId,
        name,
        kind: 'auto',
        createdBy: 'auto',
        files,
      });
      this.lastRunAtByProject.set(projectId, Date.now());
      logger.info('auto label created', { projectId, name, files: files.length });
      return { ok: true };
    } catch (err) {
      logger.warn('auto label tick failed', { error: (err as Error).message });
      return { ok: false, reason: (err as Error).message };
    } finally {
      this.running = false;
    }
  }
}

export const autoLabelScheduler = new AutoLabelScheduler();
