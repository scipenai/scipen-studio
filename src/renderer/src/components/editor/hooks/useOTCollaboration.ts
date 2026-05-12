/**
 * @file useOTCollaboration.ts - OT Collaboration Lifecycle Hook
 * @description OT connection/disconnect, joinFile/leaveFile, claimOwner
 */

import { useCallback, useEffect } from 'react';
import { api } from '../../../api';
import { useWindowEvent } from '../../../hooks';
import { isSameOrChildPath, isSamePath } from '../../../utils/pathComparison';
import type { CollaborationReviewKey } from '../../../services/core/DiffReviewService';
import { getOTService } from '../../../services/core/OTService';
import { getEditorService, getProjectRuntimeContext } from '../../../services/core/ServiceRegistry';

export interface UseOTCollaborationParams {
  collaborationConfig: {
    enabled: boolean;
    serverUrl?: string;
    token?: string;
  };
  runtime: {
    projectId: string;
    rootPath: string;
    fileId: string;
    botUserId?: string;
  };
  projectPath: string | null;
  activeTab: { _id?: string; path: string } | undefined;
  activeReviewKey: CollaborationReviewKey | null;
}

export function useOTCollaboration({
  collaborationConfig,
  runtime,
  projectPath,
  activeTab,
  activeReviewKey,
}: UseOTCollaborationParams): void {
  // Effect 1: connection lifecycle — connect/disconnect only when collab config changes; tab switches don't tear down the WebSocket.
  useEffect(() => {
    const otService = getOTService();

    if (
      collaborationConfig.enabled &&
      collaborationConfig.serverUrl &&
      collaborationConfig.token &&
      runtime.projectId &&
      projectPath &&
      isSamePath(runtime.rootPath, projectPath)
    ) {
      otService.connect({
        baseUrl: collaborationConfig.serverUrl,
        token: collaborationConfig.token,
      });
    } else {
      otService.disconnect();
    }

    // Don't disconnect in cleanup — OT connection lifecycle is owned by CollaborationBootstrapService.
    // This prevents unmounting EditorPane (e.g. switching to chat-only mode) from dropping the OT session.
    return () => {};
  }, [
    collaborationConfig.enabled,
    collaborationConfig.serverUrl,
    collaborationConfig.token,
    runtime.projectId,
    runtime.rootPath,
    projectPath,
  ]);

  const claimCollaborationOwner = useCallback(() => {
    // The local backend (IM-only) has no OT owner to register.
    if (!activeReviewKey || activeReviewKey.backend === 'local') {
      void api.collaborationOwner.clear({ backend: 'scipen-ot' });
      return;
    }

    void api.collaborationOwner.setActive({
      backend: activeReviewKey.backend,
      projectId: activeReviewKey.projectId,
      rootPath: runtime.rootPath || projectPath || null,
      fileId: activeReviewKey.fileId,
    });
  }, [activeReviewKey, runtime.rootPath, projectPath]);

  useEffect(() => {
    claimCollaborationOwner();
  }, [claimCollaborationOwner]);

  // Window focus owner management:
  // Only re-claim the owner on focus. We deliberately don't clear on blur — doing so would drop
  // remote OT updates during a brief defocus and cause the "AI said it edited but the window
  // received no review / content arrived late" mismatch.
  useWindowEvent(
    'focus' as keyof WindowEventMap,
    (() => {
      claimCollaborationOwner();
    }) as EventListener
  );

  // Effect 2: file switch — only joinFile, don't rebuild the connection.
  useEffect(() => {
    const canCollaborate = collaborationConfig.enabled && runtime.projectId;
    const otFileId = activeTab?._id;
    // Prevent joining the new project with a stale tab id on project switch:
    // activeTab's path must belong to the current project.
    const tabBelongsToProject = isSameOrChildPath(activeTab?.path, runtime.rootPath);

    if (!otFileId || !canCollaborate || !tabBelongsToProject) {
      if (runtime.fileId) {
        getProjectRuntimeContext().update({ fileId: '' });
      }
      return;
    }

    const tab = getEditorService().tabs.find((t) => t._id === otFileId);
    if (tab) {
      getOTService().setPreJoinState(otFileId, tab.content, tab.isDirty);
    }

    getOTService().joinFile(runtime.projectId, otFileId);
    getProjectRuntimeContext().update({ fileId: otFileId });
  }, [
    activeTab?._id,
    activeTab?.path,
    collaborationConfig.enabled,
    runtime.projectId,
    runtime.rootPath,
    runtime.fileId,
  ]);
}
