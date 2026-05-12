import type { StudioIMMessageMetadataDTO } from '../../../../shared/api-types';
import type { FileNode } from '../types';
import {
  getEditorService,
  getProjectRuntimeContext,
  getProjectService,
  getSettingsService,
} from '../services/core/ServiceRegistry';

/**
 * Frozen-snapshot cache — captured once a scope switch settles and reused
 * when messages are sent. Shrinks the race window where "send during a scope
 * swap" would otherwise stitch a snapshot from multiple live sources.
 */
let frozenSnapshot: CollaborationSnapshot | null = null;
let frozenConversationId: string | null = null;

/**
 * Call after a scope switch completes to freeze the current collaboration context.
 * Subsequent buildIMCollaborationMetadata calls will prefer this snapshot.
 */
export function freezeCollaborationSnapshot(conversationId: string): void {
  frozenSnapshot = buildCollaborationSnapshotLive(conversationId);
  frozenConversationId = conversationId;
}

/** Invalidate the stored snapshot when the scope changes (project or tab switch). */
export function invalidateFrozenSnapshot(): void {
  frozenSnapshot = null;
  frozenConversationId = null;
}

const ACTIVE_FILE_CONTENT_MAX_CHARS = 8000;

/** Recursively extract relative paths of every file in the tree (directories excluded). */
function flattenFileTree(node: FileNode, rootPath: string): string[] {
  const paths: string[] = [];
  const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
  function walk(n: FileNode): void {
    if (n.type === 'file') {
      const normalized = n.path.replace(/\\/g, '/');
      const rel =
        normalizedRoot && normalized.startsWith(`${normalizedRoot}/`)
          ? normalized.slice(normalizedRoot.length + 1)
          : normalized;
      paths.push(rel);
    }
    if (n.children) {
      for (const child of n.children) walk(child);
    }
  }
  walk(node);
  return paths;
}

function toCollaborationFilePath(
  activeTabPath: string | null,
  rootPath: string
): string | undefined {
  if (!activeTabPath) {
    return undefined;
  }

  const normalizedPath = activeTabPath.replace(/\\/g, '/');
  const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalizedRoot && normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  return normalizedPath;
}

type CollaborationMode = 'im-local' | 'ot-project';
type CollaborationProvider = 'im-local' | 'scipen-ot';

interface CollaborationCapabilities {
  propose_edit: boolean;
  collaborative_tree: boolean;
  collaborative_read: boolean;
  collaborative_edit: boolean;
}

export interface CollaborationSnapshot {
  provider: CollaborationProvider;
  mode: CollaborationMode;
  conversationId: string;
  projectId?: string;
  fileId?: string;
  filePath?: string;
  rootPath: string;
  projectName?: string;
  workspaceId?: string;
  capabilities: CollaborationCapabilities;
  fileTree?: string[];
  activeFileContent?: string;
  activeTabPath?: string;
}

export function buildCollaborationSnapshot(conversationId: string): CollaborationSnapshot | null {
  // Prefer the frozen snapshot when the conversationId matches and it is still fresh.
  if (frozenSnapshot && frozenConversationId === conversationId) {
    const currentFileId = getEditorService().activeTab?._id;
    const currentFilePath = getEditorService().activeTab?.path;
    const runtimeFileId = getProjectRuntimeContext().fileId;
    // A frozen snapshot is considered stale when:
    // 1. runtime.fileId has been cleared (tab closed) but the snapshot still holds the old id.
    // 2. The active tab's fileId differs from the snapshot (tab switch).
    if (!runtimeFileId && frozenSnapshot.fileId) {
      invalidateFrozenSnapshot();
    } else if (currentFileId && currentFileId !== frozenSnapshot.fileId) {
      invalidateFrozenSnapshot();
    } else if (
      currentFilePath &&
      frozenSnapshot.activeTabPath &&
      currentFilePath !== frozenSnapshot.activeTabPath
    ) {
      invalidateFrozenSnapshot();
    } else {
      return frozenSnapshot;
    }
  }
  return buildCollaborationSnapshotLive(conversationId);
}

/**
 * Build a collaboration snapshot from live runtime state.
 *
 * Source-of-truth assignment (each field has exactly one authoritative source):
 *   rootPath    ← ProjectService.projectPath        currently loaded project path
 *   projectId   ← ProjectRuntimeContext.projectId   OT project id (optional)
 *   fileId      ← EditorService.activeTab._id       OT file id of the active tab (optional)
 *   workspaceId ← Settings.assistant.openclaw       OpenClaw config (global)
 *
 * Rule: settings.collaboration.* is only accepted as a fallback when it matches
 * ProjectService.projectPath, to prevent stale data from a previous project
 * leaking into a newly opened one.
 */
function buildCollaborationSnapshotLive(conversationId: string): CollaborationSnapshot | null {
  const runtime = getProjectRuntimeContext().state;

  const normalizedConversationId = conversationId.trim();
  if (!normalizedConversationId) return null;

  // All runtime fields come from a single source: ProjectRuntimeContext.
  const { rootPath, projectId, fileId, overleafProjectId } = runtime;
  if (!rootPath) return null;

  // Derived fields
  const activeTabPath = getEditorService().activeTab?.path ?? null;
  const filePath = toCollaborationFilePath(activeTabPath, rootPath);
  const projectName = rootPath.replace(/\\/g, '/').split('/').pop() || undefined;
  const workspaceId = getSettingsService().settings.assistant.openclaw.workspaceId || undefined;
  const isOTProject = Boolean(projectId);
  // In the current architecture Overleaf is treated as a local project (with push sync on top);
  // fall back to overleafProjectId when OT is unavailable.
  const effectiveProjectId = projectId || overleafProjectId || undefined;
  const capabilities: CollaborationCapabilities = {
    propose_edit: true,
    collaborative_tree: isOTProject,
    collaborative_read: isOTProject,
    collaborative_edit: isOTProject,
  };

  // File tree: flatten paths recursively from ProjectService.
  const tree = getProjectService().fileTree;
  const fileTree = tree ? flattenFileTree(tree, rootPath) : undefined;

  // Active file content: taken from the editor tab, truncated to the first N characters.
  const activeTab = getEditorService().activeTab;
  const activeFileContent = activeTab?.content
    ? activeTab.content.slice(0, ACTIVE_FILE_CONTENT_MAX_CHARS)
    : undefined;

  return {
    provider: isOTProject ? 'scipen-ot' : 'im-local',
    mode: isOTProject ? 'ot-project' : 'im-local',
    conversationId: normalizedConversationId,
    projectId: effectiveProjectId,
    fileId: isOTProject ? fileId || undefined : undefined,
    filePath,
    rootPath,
    projectName,
    workspaceId,
    capabilities,
    fileTree,
    activeFileContent,
    activeTabPath: activeTabPath || undefined,
  };
}

export function buildIMCollaborationMetadata(
  conversationId: string
): StudioIMMessageMetadataDTO | undefined {
  const snapshot = buildCollaborationSnapshot(conversationId);
  if (!snapshot) {
    return undefined;
  }

  return {
    collaboration: {
      provider: snapshot.provider,
      mode: snapshot.mode,
      project_id: snapshot.projectId,
      file_id: snapshot.fileId,
      file_path: snapshot.filePath,
      root_path: snapshot.rootPath,
      project_name: snapshot.projectName,
      workspace_id: snapshot.workspaceId,
      scope_type: 'project',
      can_collaborate: true,
      capabilities: snapshot.capabilities,
      file_tree: snapshot.fileTree,
      active_file_content: snapshot.activeFileContent,
    },
  };
}
