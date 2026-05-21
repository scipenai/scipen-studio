/**
 * @file useAgentBridge - boots the SNACA edit-proposal bridge and syncs
 *   `Agent_EditApplied` events back into the editor.
 *
 * Also handles SNACA's reverse-RPC `flush_unsaved` request: when a SNACA
 * tool (typically `Read`) needs the freshest disk state, main forwards a
 * `Agent_ContextFlushRequest` here. We save every dirty Monaco tab, then
 * reply with the list of files actually written. Main resolves the pending
 * `context.respond` back to SNACA so the tool can proceed.
 *
 * Mounted once at app root. Idempotent — re-mounting doesn't re-subscribe.
 */

import { useEffect } from 'react';
import { agentClient } from '../services/agent/AgentClientService';
import { agentEditProposalBridge } from '../services/agent/AgentEditProposalBridge';
import { getContextZoteroResponder } from '../services/agent/ContextZoteroResponder';
import { recentEditsTracker } from '../services/agent/RecentEditsTracker';
import { getEditorService } from '../services/core';
import { api } from '../api';
import { createLogger } from '../services/LogService';

const logger = createLogger('AgentBridge');

export function useAgentBridge(): void {
  useEffect(() => {
    agentEditProposalBridge.init();
    recentEditsTracker.init();
    const zoteroResponder = getContextZoteroResponder();
    zoteroResponder.start();

    const offEditApplied = agentClient.onEditApplied((evt) => {
      const editor = getEditorService();
      const tab = editor.tabs.find((t) => sameAbsolute(t.path, evt.file));
      if (!tab) return;

      // Edit is already on disk (host_applies). Push the post-write content
      // back into Monaco the same way the file-watcher would, but without
      // touching backup/version state — this is "our own" write.
      editor.updateFileMtime(evt.file, evt.mtimeMs);
      editor.setContentFromExternal(tab.path, evt.content);
    });

    const offFlush = agentClient.onContextFlushRequest((req) => {
      void handleFlushUnsaved(req).catch((err) => {
        logger.error('flush_unsaved handler threw — replying empty', {
          requestId: req.requestId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Fire-and-forget the fallback respond. If even this fails (e.g. main
        // already torn down), there's nothing left to do — swallow rather
        // than surface an UnhandledPromiseRejection from inside a React
        // effect callback.
        agentClient
          .respondContextFlush({ requestId: req.requestId, flushedFiles: [] })
          .catch((respondErr) => {
            logger.warn('fallback respondContextFlush also failed', {
              requestId: req.requestId,
              error: respondErr instanceof Error ? respondErr.message : String(respondErr),
            });
          });
      });
    });

    return () => {
      offEditApplied();
      offFlush();
      zoteroResponder.stop();
    };
  }, []);
}

/**
 * Save the requested dirty tabs (or all if `paths` is omitted) and respond
 * to main. Saves only flip `isDirty=false` when the on-disk content matches
 * what we just wrote — concurrent edits during the save are preserved via
 * `EditorService.completeSave`'s version check.
 */
async function handleFlushUnsaved(req: { requestId: string; paths?: string[] }): Promise<void> {
  const editor = getEditorService();
  const filter = req.paths ? new Set(req.paths.map(normalizePath)) : null;
  const flushed: string[] = [];

  for (const tab of editor.tabs) {
    if (!tab.isDirty) continue;
    if (filter && !filter.has(normalizePath(tab.path))) continue;

    const saveInfo = editor.beginSave(tab.path);
    if (!saveInfo) continue;
    try {
      await api.file.write(tab.path, saveInfo.content);
      editor.updateFileMtime(tab.path, Date.now());
      editor.completeSave(tab.path, saveInfo.version);
      flushed.push(tab.path);
    } catch (err) {
      logger.warn('flush_unsaved: failed to write tab', {
        path: tab.path,
        error: err instanceof Error ? err.message : String(err),
      });
      // Keep going — partial flush is better than none.
    }
  }

  await agentClient.respondContextFlush({
    requestId: req.requestId,
    flushedFiles: flushed,
  });
}

function sameAbsolute(a: string, b: string): boolean {
  return normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase();
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}
