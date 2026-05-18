/**
 * @file RecentEditsTracker — rolling buffer of user-edit summaries.
 *
 * Subscribes to `EditorService.onDidChangeContent` and produces one
 * `RecentEdit` per quiescence window (default 500ms debounce per file).
 * Programmatic updates (`forceUpdate=true`, e.g. Diff Review accept) and
 * dirty=false transitions (saves) are skipped — we only want signal from
 * actual user typing.
 *
 * Snapshot is read by `ChatContextBuilder` and stamped onto `recent_edits`.
 */

import { getEditorService, getProjectService } from '../core';

export interface RecentEditEntry {
  /** Project-relative path (forward-slash) for compactness in prompts. */
  path: string;
  /** ISO-8601 timestamp of the last edit in this window. */
  ts: string;
  /** Human-readable summary, e.g. `edited +42/-7 chars`. */
  summary: string;
}

interface PendingEdit {
  path: string;
  baselineLength: number;
  latestLength: number;
  changes: number;
  firstSeenAt: number;
  lastSeenAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_BUFFER = 20;
const DEFAULT_DEBOUNCE_MS = 500;

class RecentEditsTrackerImpl {
  private subscribed = false;
  private readonly buffer: RecentEditEntry[] = [];
  private readonly pending = new Map<string, PendingEdit>();
  private readonly bufferLimit: number;
  private readonly debounceMs: number;

  constructor(bufferLimit = DEFAULT_BUFFER, debounceMs = DEFAULT_DEBOUNCE_MS) {
    this.bufferLimit = bufferLimit;
    this.debounceMs = debounceMs;
  }

  /** Idempotent — first caller wires the subscription. */
  init(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    getEditorService().onDidChangeContent((evt) => {
      // Programmatic updates (refactors, Diff Review apply, external sync)
      // are not user edits.
      if (evt.forceUpdate) return;
      // Dirty=false fires on save / external sync. Skip.
      if (!evt.isDirty) return;
      this.observe(evt.path, evt.content.length);
    });
  }

  /** Snapshot (newest first), capped at `limit`. */
  snapshot(limit?: number): RecentEditEntry[] {
    const cap = limit ?? this.bufferLimit;
    if (cap >= this.buffer.length) return [...this.buffer].reverse();
    return [...this.buffer].slice(-cap).reverse();
  }

  /** For tests. */
  clear(): void {
    this.buffer.length = 0;
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
    }
    this.pending.clear();
  }

  private observe(path: string, newLength: number): void {
    const now = Date.now();
    let entry = this.pending.get(path);
    if (!entry) {
      entry = {
        path,
        baselineLength: newLength,
        latestLength: newLength,
        changes: 0,
        firstSeenAt: now,
        lastSeenAt: now,
        timer: null,
      };
      this.pending.set(path, entry);
    }
    entry.changes += 1;
    entry.latestLength = newLength;
    entry.lastSeenAt = now;

    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.flush(path), this.debounceMs);
  }

  private flush(path: string): void {
    const entry = this.pending.get(path);
    if (!entry) return;
    this.pending.delete(path);

    const delta = entry.latestLength - entry.baselineLength;
    const sign = delta >= 0 ? '+' : '';
    const summary = `edited ${sign}${delta} chars in ${entry.changes} bursts`;

    this.buffer.push({
      path: toRelativePath(path),
      ts: new Date(entry.lastSeenAt).toISOString(),
      summary,
    });
    if (this.buffer.length > this.bufferLimit) {
      this.buffer.splice(0, this.buffer.length - this.bufferLimit);
    }
  }
}

function toRelativePath(absPath: string): string {
  const normalized = absPath.replace(/\\/g, '/');
  const root = getProjectService().projectPath;
  if (!root) return normalized;
  const normRoot = root.replace(/\\/g, '/');
  const withSep = normRoot.endsWith('/') ? normRoot : normRoot + '/';
  return normalized.startsWith(withSep) ? normalized.slice(withSep.length) : normalized;
}

export const recentEditsTracker = new RecentEditsTrackerImpl();
