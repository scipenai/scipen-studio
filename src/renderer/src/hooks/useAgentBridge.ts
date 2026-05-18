/**
 * @file useAgentBridge - boots the SNACA edit-proposal bridge and syncs
 *   `Agent_EditApplied` events back into the editor.
 *
 * Mounted once at app root. Idempotent — re-mounting doesn't re-subscribe.
 */

import { useEffect } from 'react';
import { agentClient } from '../services/agent/AgentClientService';
import { agentEditProposalBridge } from '../services/agent/AgentEditProposalBridge';
import { recentEditsTracker } from '../services/agent/RecentEditsTracker';
import { getEditorService } from '../services/core';

export function useAgentBridge(): void {
  useEffect(() => {
    agentEditProposalBridge.init();
    recentEditsTracker.init();

    const unsubscribe = agentClient.onEditApplied((evt) => {
      const editor = getEditorService();
      const tab = editor.tabs.find((t) => sameAbsolute(t.path, evt.file));
      if (!tab) return;

      // Edit is already on disk (host_applies). Push the post-write content
      // back into Monaco the same way the file-watcher would, but without
      // touching backup/version state — this is "our own" write.
      editor.updateFileMtime(evt.file, evt.mtimeMs);
      editor.setContentFromExternal(tab.path, evt.content);
    });

    return () => {
      unsubscribe();
    };
  }, []);
}

function sameAbsolute(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}
