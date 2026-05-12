/**
 * @file projectBindingHandlers - Project binding IPC handlers
 * @description Registers IPC channels for project binding / conflict detection and forwards events to the renderer.
 * @depends ProjectBindingService, ExternalChangeDetector, typedIpc
 */

import path from 'path';
import fs from 'fs-extra';
import { BrowserWindow } from 'electron';
import { eq, and } from 'drizzle-orm';
import { IpcChannel } from '../../../shared/ipc/channels';
import type {
  ExternalChangeBatchDTO,
  ExternalChangeAutoResolvedDTO,
  ProjectBindingStatusEvent,
  ConflictResolutionChoice,
  EnsureBindingFromBootstrapParams,
} from '../../../shared/api-types';
import type { ExternalChangeFile } from '../services/ExternalChangeDetector';
import { getDatabase, syncFileSnapshotsTable } from '../database';
import type { ProjectBindingService } from '../services/ProjectBindingService';
import type { ExternalChangeDetector } from '../services/ExternalChangeDetector';
import type { StudioOTService } from '../services/StudioOTService';
import type { ReplicaWritebackService } from '../services/ReplicaWritebackService';
import { ServiceNames, getServiceContainer } from '../services/ServiceContainer';
import { createLogger } from '../services/LoggerService';
import { registerHandler } from './typedIpc';

const logger = createLogger('ProjectBindingHandlers');
let eventForwardingSetup = false;

function getBindingService(): ProjectBindingService {
  return getServiceContainer().get<ProjectBindingService>(ServiceNames.PROJECT_BINDING);
}

function getChangeDetector(): ExternalChangeDetector {
  return getServiceContainer().get<ExternalChangeDetector>(ServiceNames.EXTERNAL_CHANGE_DETECTOR);
}

function getOTService(): StudioOTService {
  return getServiceContainer().get<StudioOTService>(ServiceNames.STUDIO_OT);
}

function getWritebackService(): ReplicaWritebackService {
  return getServiceContainer().get<ReplicaWritebackService>(ServiceNames.REPLICA_WRITEBACK);
}

function broadcast(channel: IpcChannel, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
}

function setupEventForwarding(): void {
  if (eventForwardingSetup) return;
  eventForwardingSetup = true;

  // Forward project binding status events
  const bindingService = getBindingService();
  bindingService.onStatusChanged((event: ProjectBindingStatusEvent) => {
    broadcast(IpcChannel.ProjectBinding_StatusChanged, event);
  });

  // External change detection: cloud is the single source of truth, auto-route accordingly
  const detector = getChangeDetector();
  detector.onExternalChange(async (batch) => {
    try {
      // Resolve projectId
      let projectId: string | null = null;
      try {
        const binding = await getBindingService().getBindingByPath(batch.projectRootPath);
        if (binding) projectId = binding.projectId;
      } catch {
        // Lookup failure is non-blocking
      }

      // Group by syncStatus
      const autoResolveFiles: ExternalChangeFile[] = [];
      const newFiles: ExternalChangeFile[] = [];

      for (const f of batch.files) {
        if (f.syncStatus === 'CONFLICT' || f.syncStatus === 'DELETED') {
          autoResolveFiles.push(f);
        } else if (f.syncStatus === 'NEW') {
          newFiles.push(f);
        }
        // SYNCED: ignore
      }

      // Auto-resolve CONFLICT/DELETED: cloud is the single source of truth
      if (autoResolveFiles.length > 0 && projectId) {
        const resolvedFiles: ExternalChangeAutoResolvedDTO['resolvedFiles'] = [];
        for (const f of autoResolveFiles) {
          try {
            if (f.syncStatus === 'CONFLICT') {
              await resolveConflict(projectId, batch.projectRootPath, f.relativePath, 'keep_cloud');
              resolvedFiles.push({ relativePath: f.relativePath, action: 'cloud_overwrite' });
            } else {
              // DELETED: local file was removed; cloud is unaffected, just notify
              resolvedFiles.push({ relativePath: f.relativePath, action: 'local_deleted' });
            }
          } catch (err) {
            logger.error(`Auto-resolve failed: ${f.relativePath}`, err);
          }
        }
        if (resolvedFiles.length > 0) {
          const notification: ExternalChangeAutoResolvedDTO = {
            projectId,
            resolvedFiles,
            resolvedAt: Date.now(),
          };
          broadcast(IpcChannel.ExternalChange_AutoResolved, notification);
        }
      }

      // Push NEW files to the renderer so the user can decide whether to upload
      if (newFiles.length > 0) {
        const dto: ExternalChangeBatchDTO = {
          batchId: batch.batchId,
          projectId,
          projectRootPath: batch.projectRootPath,
          files: newFiles.map((f) => ({
            relativePath: f.relativePath,
            absolutePath: f.absolutePath,
            changeType: f.changeType,
            fileSize: f.fileSize,
            syncStatus: f.syncStatus,
          })),
          isBulk: newFiles.length >= 5,
          detectedAt: batch.detectedAt,
        };
        broadcast(IpcChannel.ExternalChange_Detected, dto);
      }
    } catch (err) {
      logger.error('Unhandled external change processing error', err);
    }
  });
}

export function registerProjectBindingHandlers(): void {
  registerHandler(IpcChannel.ProjectBinding_Import, async (params) => {
    logger.info(`IPC: Import project ${params.localRootPath}`);
    setupEventForwarding();
    return getBindingService().importProject(params);
  });

  registerHandler(IpcChannel.ProjectBinding_Unbind, async (projectId) => {
    logger.info(`IPC: Unbind project ${projectId}`);
    await getBindingService().unbindProject(projectId);
    return { success: true };
  });

  registerHandler(IpcChannel.ProjectBinding_GetByPath, async (localRootPath) => {
    return getBindingService().getBindingByPath(localRootPath);
  });

  registerHandler(IpcChannel.ProjectBinding_GetByProjectId, async (projectId) => {
    return getBindingService().getBindingByProjectId(projectId);
  });

  registerHandler(IpcChannel.ProjectBinding_Resolve, async (localRootPath) => {
    return getBindingService().resolveBinding(localRootPath);
  });

  registerHandler(
    IpcChannel.ProjectBinding_EnsureBootstrap,
    async (params: EnsureBindingFromBootstrapParams) => {
      setupEventForwarding();
      return getBindingService().ensureBindingFromBootstrap(params);
    }
  );

  registerHandler(IpcChannel.ProjectBinding_SetEnabled, async (projectId, enabled) => {
    await getBindingService().setEnabled(projectId, enabled);
    return { success: true };
  });

  // Conflict resolution: renderer submits the user's choice (only NEW files are user-driven)
  registerHandler(IpcChannel.ExternalChange_Resolve, async (params) => {
    logger.info(
      `IPC: Resolve conflict batch ${params.batchId} (${params.resolutions.length} files)`
    );

    const binding = await getBindingService().getBindingByPath(params.projectRootPath);
    if (!binding) {
      logger.error(`Conflict resolution failed: binding not found for ${params.projectRootPath}`);
      return { success: false, resolved: 0, failed: 0, errors: ['项目绑定未找到'] };
    }

    let resolved = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const resolution of params.resolutions) {
      try {
        await resolveConflict(
          binding.projectId,
          binding.localRootPath,
          resolution.relativePath,
          resolution.choice
        );
        resolved++;
      } catch (err) {
        const msg = `${resolution.relativePath}: ${err instanceof Error ? err.message : String(err)}`;
        logger.error(`Conflict resolution failed: ${msg}`);
        errors.push(msg);
        failed++;
      }
    }

    logger.info(`Conflict resolution completed: ${resolved} succeeded, ${failed} failed`);
    return { success: failed === 0, resolved, failed, errors };
  });

  // ====== Ops actions ======

  registerHandler(IpcChannel.ProjectBinding_Rebuild, async (params) => {
    logger.info(`IPC: Rebuild working copy ${params.localRootPath}`);
    return getBindingService().rebuildWorkingCopy(params);
  });

  registerHandler(IpcChannel.ProjectBinding_Rebind, async (params) => {
    logger.info(`IPC: Rebind ${params.localRootPath} -> ${params.remoteProjectId}`);
    return getBindingService().rebindProject(params);
  });

  registerHandler(IpcChannel.ProjectBinding_ExportSnapshot, async (params) => {
    logger.info(`IPC: Export snapshot ${params.remoteProjectId} -> ${params.exportPath}`);
    return getBindingService().exportSnapshot(params);
  });

  logger.info('Project binding IPC handlers registered');
}

// ====== Conflict resolution logic ======

/**
 * Resolve a single file's conflict (cloud is the single source of truth).
 *
 * - keep_cloud: pull latest content from OT and overwrite the local file
 * - skip: no-op
 */
async function resolveConflict(
  projectId: string,
  localRootPath: string,
  relativePath: string,
  choice: ConflictResolutionChoice
): Promise<void> {
  if (choice === 'skip') {
    logger.info(`Skipped conflict: ${relativePath}`);
    return;
  }

  const db = getDatabase();

  // Look up the file snapshot (scoped by projectId to avoid hitting same-named files in other projects)
  const snapshots = await db
    .select()
    .from(syncFileSnapshotsTable)
    .where(
      and(
        eq(syncFileSnapshotsTable.projectId, projectId),
        eq(syncFileSnapshotsTable.filePath, relativePath)
      )
    )
    .limit(1);

  if (snapshots.length === 0) {
    throw new Error(`无法找到文件快照记录: ${projectId}/${relativePath}`);
  }

  const snapshot = snapshots[0];
  if (!snapshot.fileId) {
    throw new Error(`文件未关联 OT fileId: ${relativePath}`);
  }

  const otService = getOTService();
  const absolutePath = path.join(localRootPath, relativePath);
  const { createHash } = await import('crypto');

  if (choice === 'keep_cloud') {
    const cloudFile = await otService.getProjectFile(projectId, snapshot.fileId);
    const writebackService = getWritebackService();
    writebackService.echoSuppressor.register(absolutePath, cloudFile.content);
    await fs.ensureDir(path.dirname(absolutePath));
    await fs.writeFile(absolutePath, cloudFile.content, 'utf-8');

    // Update snapshot: sync hash, size, otVersion
    const newHash = createHash('md5').update(cloudFile.content).digest('hex').slice(0, 8);
    await db
      .update(syncFileSnapshotsTable)
      .set({
        contentHash: newHash,
        fileSize: Buffer.byteLength(cloudFile.content, 'utf-8'),
        otVersion: cloudFile.version,
      })
      .where(
        and(
          eq(syncFileSnapshotsTable.projectId, projectId),
          eq(syncFileSnapshotsTable.filePath, relativePath)
        )
      );

    logger.info(`keep_cloud: overwrote local file ${relativePath}`);
  }
}
