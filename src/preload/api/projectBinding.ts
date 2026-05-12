/**
 * @file projectBinding Preload API
 * @description Renderer-side API for project binding (cloud collaboration).
 */

import { ipcRenderer } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import type {
  ExternalChangeBatchDTO,
  ExternalChangeAutoResolvedDTO,
  ExportSnapshotParams,
  ExportSnapshotResult,
  ImportProjectParams,
  ImportProjectResult,
  EnsureBindingFromBootstrapParams,
  EnsureBindingFromBootstrapResult,
  ProjectBindingDTO,
  ProjectBindingStatusEvent,
  RebindProjectParams,
  RebindProjectResult,
  RebuildWorkingCopyParams,
  RebuildWorkingCopyResult,
  ResolveBindingResult,
  ResolveExternalChangeParams,
} from '../../../shared/api-types';
import { createSafeListener } from './_shared';

export const projectBindingApi = {
  importProject: (params: ImportProjectParams) =>
    ipcRenderer.invoke(IpcChannel.ProjectBinding_Import, params) as Promise<ImportProjectResult>,

  unbindProject: (projectId: string) =>
    ipcRenderer.invoke(IpcChannel.ProjectBinding_Unbind, projectId) as Promise<{
      success: boolean;
    }>,

  getByPath: (localRootPath: string) =>
    ipcRenderer.invoke(
      IpcChannel.ProjectBinding_GetByPath,
      localRootPath
    ) as Promise<ProjectBindingDTO | null>,

  getByProjectId: (projectId: string) =>
    ipcRenderer.invoke(
      IpcChannel.ProjectBinding_GetByProjectId,
      projectId
    ) as Promise<ProjectBindingDTO | null>,

  resolve: (localRootPath: string) =>
    ipcRenderer.invoke(
      IpcChannel.ProjectBinding_Resolve,
      localRootPath
    ) as Promise<ResolveBindingResult>,

  ensureBindingFromBootstrap: (params: EnsureBindingFromBootstrapParams) =>
    ipcRenderer.invoke(
      IpcChannel.ProjectBinding_EnsureBootstrap,
      params
    ) as Promise<EnsureBindingFromBootstrapResult>,

  setEnabled: (projectId: string, enabled: boolean) =>
    ipcRenderer.invoke(IpcChannel.ProjectBinding_SetEnabled, projectId, enabled) as Promise<{
      success: boolean;
    }>,

  onStatusChanged: createSafeListener<ProjectBindingStatusEvent>(
    IpcChannel.ProjectBinding_StatusChanged
  ),

  // External change detection
  resolveExternalChange: (params: ResolveExternalChangeParams) =>
    ipcRenderer.invoke(IpcChannel.ExternalChange_Resolve, params) as Promise<{ success: boolean }>,

  onExternalChangeDetected: createSafeListener<ExternalChangeBatchDTO>(
    IpcChannel.ExternalChange_Detected
  ),

  /** Notifications of auto-resolutions when cloud is the single source of truth. */
  onExternalChangeAutoResolved: createSafeListener<ExternalChangeAutoResolvedDTO>(
    IpcChannel.ExternalChange_AutoResolved
  ),

  // ====== Maintenance actions ======

  /** Fully rebuild the local working copy from the remote. */
  rebuildWorkingCopy: (params: RebuildWorkingCopyParams) =>
    ipcRenderer.invoke(
      IpcChannel.ProjectBinding_Rebuild,
      params
    ) as Promise<RebuildWorkingCopyResult>,

  /** Point the local directory at an existing remote project. */
  rebindProject: (params: RebindProjectParams) =>
    ipcRenderer.invoke(IpcChannel.ProjectBinding_Rebind, params) as Promise<RebindProjectResult>,

  /** Export a snapshot of the remote project. */
  exportSnapshot: (params: ExportSnapshotParams) =>
    ipcRenderer.invoke(
      IpcChannel.ProjectBinding_ExportSnapshot,
      params
    ) as Promise<ExportSnapshotResult>,
};
