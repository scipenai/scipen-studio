/**
 * @file historyRestore - shared logic for applying a `{fileId → bytes}` snapshot
 *   (from a label or a step) onto the currently open editor tabs.
 *
 * Same handshake everywhere a restore happens (label restore, step rollback):
 * write the file, then `setContentFromExternal` so the editor model picks up
 * the new content without dirty-flag confusion. Files in the snapshot but not
 * currently open are skipped — opening them post-restore would surprise the
 * user; P3 will add an explicit "restore all (incl. closed)" path.
 */

import { api } from '../api';
import { getEditorService } from '../services/core';
import { triggerOverleafSyncAfterSave } from './overleaf-sync-helper';

export interface ApplySnapshotResult {
  /** Number of tabs whose content was actually rewritten (skips no-op identical content). */
  count: number;
  /** Tabs that were referenced by the snapshot but were not open. */
  skipped: number;
}

/**
 * Apply a `fileId → bytes` snapshot to the currently open editor tabs.
 *
 * Three things happen per matched tab, in order:
 *  1. `api.file.write` rewrites the on-disk file (atomic).
 *  2. `setContentFromExternal` syncs the in-memory Monaco model.
 *  3. `triggerOverleafSyncAfterSave` fires the Overleaf push pipeline.
 *
 * Step 3 is the rollback's "broadcast" path: scipen-studio doesn't talk OT,
 * so collaborative sync lives in the Overleaf local-first layer. If the
 * current project is not connected to Overleaf the trigger is a no-op
 * (`triggerOverleafSyncAfterSave` short-circuits on `!overleafProjectId`).
 */
export async function applySnapshotToOpenTabs(
  snapshot: Record<string, Uint8Array>
): Promise<ApplySnapshotResult> {
  const tabs = getEditorService().tabs;
  if (tabs.length === 0) throw new Error('no open tabs');

  const decoder = new TextDecoder();
  let count = 0;
  let skipped = 0;
  for (const [fileId, bytes] of Object.entries(snapshot)) {
    const tab = tabs.find((tt) => tt._id === fileId || tt.path === fileId);
    if (!tab) {
      skipped++;
      continue;
    }
    const content = decoder.decode(bytes);
    if (tab.content === content) continue;
    await api.file.write(tab.path, content);
    getEditorService().setContentFromExternal(tab.path, content);
    // Broadcast through Overleaf sync (no-op for non-Overleaf projects).
    triggerOverleafSyncAfterSave({
      filePath: tab.path,
      content,
      fileName: tab.name,
      addLog: () => {},
    });
    count++;
  }
  return { count, skipped };
}
