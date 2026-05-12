/**
 * @file ProjectBindingService - project onboarding and identity mapping service.
 * @description Manages a three-layer mapping between a local directory and the cloud OT
 *   collaborative project:
 *   1. Local marker file (.scipen/project.json).
 *   2. Client-side local database (projectBindingsTable).
 *   3. Cloud project registration (via StudioOTService).
 *
 * @depends database, StudioOTService, FileSystemService, LoggerService
 */

import { createHash } from 'crypto';
import path from 'path';
import fs from 'fs-extra';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { Emitter } from '../../../shared/utils';
import { getDatabase, projectBindingsTable, syncFileSnapshotsTable } from '../database';
import type {
  EnsureBindingFromBootstrapParams,
  EnsureBindingFromBootstrapResult,
  ExportSnapshotParams,
  ExportSnapshotResult,
  ImportProjectParams,
  ImportProjectResult,
  ProjectBindingDTO,
  ProjectBindingStatusEvent,
  RebindProjectParams,
  RebindProjectResult,
  RebuildWorkingCopyParams,
  RebuildWorkingCopyResult,
  RemoteProjectAuthority,
  RemoteProjectBackend,
  RemoteProjectMaterialization,
  ResolveBindingResult,
  ScipenProjectMarker,
} from '../../../shared/api-types';
import type { IProjectBindingService } from './interfaces/IProjectBindingService';
import { ALWAYS_IGNORE_DIRS, OT_MANAGED_EXTENSIONS } from './interfaces/IProjectBindingService';
import type { IDisposable } from './ServiceContainer';
import { createLogger } from './LoggerService';
import { ServiceNames, getServiceContainer } from './ServiceContainer';
import type { StudioOTService } from './StudioOTService';
import { getReplicaWritebackService, getExternalChangeDetector } from './ServiceRegistry';
import { getFileWorkerClient, type FileChangeEvent } from '../workers/FileWorkerClient';

const logger = createLogger('ProjectBindingService');

const SCIPEN_DIR = '.scipen';
const MARKER_FILE = 'project.json';
const MARKER_SCHEMA_VERSION = 2;
const DEFAULT_BACKEND: RemoteProjectBackend = 'scipen-ot';
const DEFAULT_AUTHORITY: RemoteProjectAuthority = 'remote';
const DEFAULT_MATERIALIZATION: RemoteProjectMaterialization = 'local-working-copy';
const DERIVED_OUTPUT_DIRS = new Set(['output', 'out', 'dist', 'build', 'target']);

// ====== Utilities ======

function getMarkerPath(localRootPath: string): string {
  return path.join(localRootPath, SCIPEN_DIR, MARKER_FILE);
}

function isOTManaged(filePath: string): boolean {
  return OT_MANAGED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function shouldIgnore(relativePath: string): boolean {
  const parts = relativePath.split(path.sep);
  return parts.some((part) => ALWAYS_IGNORE_DIRS.has(part));
}

function computeHash(content: string | Buffer): string {
  return createHash('md5').update(content).digest('hex').slice(0, 8);
}

function isDerivedOutputDirectory(localRootPath: string): boolean {
  return DERIVED_OUTPUT_DIRS.has(path.basename(localRootPath).toLowerCase());
}

function toBindingDTO(
  row: typeof projectBindingsTable.$inferSelect,
  status: ProjectBindingStatusEvent['status'] = 'bound'
): ProjectBindingDTO {
  return {
    id: row.id,
    projectId: row.projectId,
    workspaceId: row.workspaceId,
    backend: (row.backend as RemoteProjectBackend | null) ?? DEFAULT_BACKEND,
    authority: (row.authority as RemoteProjectAuthority | null) ?? DEFAULT_AUTHORITY,
    materialization:
      (row.materialization as RemoteProjectMaterialization | null) ?? DEFAULT_MATERIALIZATION,
    remoteProjectId: row.projectId,
    localRootPath: row.localRootPath,
    projectName: row.projectName,
    enabled: row.enabled ?? true,
    lastSyncAt: row.lastSyncAt ? row.lastSyncAt.getTime() : null,
    status,
  };
}

// ====== Service implementation ======

export class ProjectBindingService implements IProjectBindingService {
  private readonly _onStatusChanged = new Emitter<ProjectBindingStatusEvent>();
  /** Currently active collaborative project path (only one at a time). */
  private activeProjectPath: string | null = null;
  /** Concurrency lock for resolveBinding to prevent multi-window races. */
  private resolveLock: Promise<ResolveBindingResult> | null = null;
  /** Retained FileWorkerClient listener reference for cleanup. */
  private fileChangeHandler: ((event: FileChangeEvent) => void) | null = null;

  onStatusChanged(listener: (event: ProjectBindingStatusEvent) => void): IDisposable {
    return this._onStatusChanged.event(listener);
  }

  async importProject(params: ImportProjectParams): Promise<ImportProjectResult> {
    const { localRootPath, customIgnorePatterns } = params;
    const projectName = params.projectName || path.basename(localRootPath);

    logger.info(`Importing project: ${localRootPath} (${projectName})`);

    // Preconditions.
    if (!(await fs.pathExists(localRootPath))) {
      throw new Error(`目录不存在: ${localRootPath}`);
    }
    const existing = await this.getBindingByPath(localRootPath);
    if (existing) {
      throw new Error(`目录已绑定到协同项目: ${existing.projectId}`);
    }

    this.emitStatus(localRootPath, '', 'syncing', '正在扫描目录...');

    // Step 1: scan directory and classify files.
    const { textFiles, resourceFiles, skipped } = await this.scanDirectory(
      localRootPath,
      customIgnorePatterns
    );
    logger.info(
      `Directory scan completed: ${textFiles.length} text files, ${resourceFiles.length} resource files, ${skipped} skipped`
    );

    this.emitStatus(localRootPath, '', 'syncing', '正在创建云端项目...');

    // Step 2: create the cloud project via OT Server (uploading text files).
    let projectId: string;
    let snapshot: Awaited<ReturnType<StudioOTService['openLocalProject']>>;
    try {
      const otService = getServiceContainer().get<StudioOTService>(ServiceNames.STUDIO_OT);
      snapshot = await otService.openLocalProject({
        root_path: localRootPath,
        name: projectName,
        files: textFiles.map((f) => ({
          file_path: f.relativePath,
          content: f.content,
        })),
        folders: this.extractFolders(textFiles.map((f) => f.relativePath)),
      });
      projectId = snapshot.project.id;
    } catch (err) {
      this.emitStatus(localRootPath, '', 'error', '云端项目创建失败');
      throw err;
    }

    // Step 3: write the local marker and DB (rolls back the cloud project on failure).
    const workspaceId = snapshot.project.workspace || 'private';
    const bindingId = uuidv4();
    try {
      this.emitStatus(localRootPath, projectId, 'syncing', '正在建立本地绑定...');

      await this.writeMarkerFile(localRootPath, {
        projectId,
        workspaceId,
        backend: DEFAULT_BACKEND,
      });

      const db = getDatabase();
      await db.insert(projectBindingsTable).values({
        id: bindingId,
        projectId,
        workspaceId,
        backend: DEFAULT_BACKEND,
        authority: DEFAULT_AUTHORITY,
        materialization: DEFAULT_MATERIALIZATION,
        localRootPath: path.normalize(localRootPath),
        projectName,
        enabled: true,
        lastSyncAt: new Date(),
        customIgnorePatterns: customIgnorePatterns ?? null,
      });

      // Step 4: seed the initial sync snapshot (baseline for text and resource files).
      this.emitStatus(localRootPath, projectId, 'syncing', '正在建立同步快照...');
      await this.createInitialSnapshot(projectId, snapshot, textFiles, resourceFiles);
    } catch (err) {
      // Rollback: remove local marker and DB rows.
      logger.error(`Import failed mid-flight, rolling back: ${projectId}`, err);
      await this.rollbackImport(localRootPath, projectId);
      this.emitStatus(localRootPath, projectId, 'error', '导入失败，已回滚');
      throw err;
    }

    const binding = await this.getBindingByProjectId(projectId);
    if (!binding) {
      throw new Error('绑定写入数据库后无法读取，数据不一致');
    }

    this.emitStatus(localRootPath, projectId, 'bound', `项目已导入: ${projectName}`);
    logger.info(`Project import succeeded: ${projectId}`);

    // Auto-activate collaborative state after a successful import.
    this.activateCollaboration(binding);

    return {
      binding,
      textFilesImported: textFiles.length,
      resourceFilesImported: resourceFiles.length,
      skippedFiles: skipped,
    };
  }

  async unbindProject(projectId: string): Promise<void> {
    const binding = await this.getBindingByProjectId(projectId);
    if (!binding) {
      logger.warn(`Unbind skipped: binding not found for project ${projectId}`);
      return;
    }

    // Disable collaboration first.
    this.deactivateCollaboration();

    // Remove the local marker file.
    const markerPath = getMarkerPath(binding.localRootPath);
    if (await fs.pathExists(markerPath)) {
      await fs.remove(markerPath);
      // Remove the empty .scipen directory too.
      const scipenDir = path.dirname(markerPath);
      const remaining = await fs.readdir(scipenDir);
      if (remaining.length === 0) {
        await fs.remove(scipenDir);
      }
    }

    // Remove DB rows (binding + sync snapshots).
    const db = getDatabase();
    await db.delete(syncFileSnapshotsTable).where(eq(syncFileSnapshotsTable.projectId, projectId));
    await db.delete(projectBindingsTable).where(eq(projectBindingsTable.projectId, projectId));

    this._onStatusChanged.fire({
      projectId,
      localRootPath: binding.localRootPath,
      status: 'unbound',
      message: `项目已解绑: ${binding.projectName}`,
    });

    logger.info(`Project unbound successfully: ${projectId}`);
  }

  async getBindingByPath(localRootPath: string): Promise<ProjectBindingDTO | null> {
    const db = getDatabase();
    const normalized = path.normalize(localRootPath);
    const rows = await db
      .select()
      .from(projectBindingsTable)
      .where(eq(projectBindingsTable.localRootPath, normalized))
      .limit(1);

    return rows.length > 0 ? toBindingDTO(rows[0]) : null;
  }

  async getBindingByProjectId(projectId: string): Promise<ProjectBindingDTO | null> {
    const db = getDatabase();
    const rows = await db
      .select()
      .from(projectBindingsTable)
      .where(eq(projectBindingsTable.projectId, projectId))
      .limit(1);

    return rows.length > 0 ? toBindingDTO(rows[0]) : null;
  }

  async ensureBindingFromBootstrap(
    params: EnsureBindingFromBootstrapParams
  ): Promise<EnsureBindingFromBootstrapResult> {
    const localRootPath = path.normalize(params.localRootPath);
    const backend = params.backend ?? DEFAULT_BACKEND;
    const resolved = await this.resolveBinding(localRootPath);

    if (resolved.binding) {
      if (
        resolved.binding.remoteProjectId === params.remoteProjectId &&
        resolved.binding.backend === backend
      ) {
        if (resolved.binding.enabled) {
          this.activateCollaboration(resolved.binding);
        }
        return {
          created: false,
          recovered: resolved.source === 'marker_file',
          binding: resolved.binding,
        };
      }
      // Old binding points to a different remote project (e.g. bootstrap rebuilt after 403)
      // — update the binding.
      logger.info(
        `Binding redirected: ${localRootPath} from ${resolved.binding.backend}/${resolved.binding.remoteProjectId} -> ${backend}/${params.remoteProjectId}`
      );
      const db = getDatabase();
      await db
        .update(projectBindingsTable)
        .set({
          projectId: params.remoteProjectId,
          backend,
          projectName: params.projectName || resolved.binding.projectName,
          lastSyncAt: new Date(),
        })
        .where(eq(projectBindingsTable.localRootPath, localRootPath));
      await this.writeMarkerFile(localRootPath, {
        projectId: params.remoteProjectId,
        workspaceId: 'private',
        backend,
      });
      const updated = await this.getBindingByPath(localRootPath);
      if (updated?.enabled) {
        this.activateCollaboration(updated);
      }
      return { created: false, recovered: false, binding: updated! };
    }

    if (!(await fs.pathExists(localRootPath))) {
      throw new Error(`目录不存在: ${localRootPath}`);
    }

    const projectName = params.projectName || path.basename(localRootPath);
    const { textFiles, resourceFiles } = await this.scanDirectory(localRootPath, undefined);

    // Only the scipen-ot backend needs to fetch a snapshot from OT to verify the project.
    let snapshot: Awaited<ReturnType<StudioOTService['getProjectSnapshot']>> | null = null;
    if (backend === 'scipen-ot') {
      const otService = getServiceContainer().get<StudioOTService>(ServiceNames.STUDIO_OT);
      snapshot = await otService.getProjectSnapshot(params.remoteProjectId);
    }

    const workspaceId = snapshot?.project.workspace || 'private';
    await this.writeMarkerFile(localRootPath, {
      projectId: params.remoteProjectId,
      workspaceId,
      backend,
    });

    const db = getDatabase();
    await db.insert(projectBindingsTable).values({
      id: uuidv4(),
      projectId: params.remoteProjectId,
      workspaceId,
      backend,
      authority: DEFAULT_AUTHORITY,
      materialization: DEFAULT_MATERIALIZATION,
      localRootPath,
      projectName,
      enabled: true,
      lastSyncAt: new Date(),
      customIgnorePatterns: null,
    });

    if (snapshot) {
      await this.createInitialSnapshot(params.remoteProjectId, snapshot, textFiles, resourceFiles);
    }

    const binding = await this.getBindingByProjectId(params.remoteProjectId);
    if (!binding) {
      throw new Error('Bootstrap 绑定建立失败');
    }

    this.emitStatus(
      localRootPath,
      params.remoteProjectId,
      'bound',
      `bootstrap 绑定完成: ${projectName}`
    );
    this.activateCollaboration(binding);
    return { created: true, recovered: false, binding };
  }

  /**
   * Look up binding information.
   * @param activate - Whether to auto-activate collaboration when an enabled binding is
   *   found (default true). Pass false for probe/query use cases to avoid side effects.
   */
  async resolveBinding(localRootPath: string, activate = true): Promise<ResolveBindingResult> {
    // Concurrency lock: wait for a prior resolve to finish, preventing multi-window races.
    if (this.resolveLock) {
      // Errors from the previous call are handled by its caller; we only need it to settle.
      await this.resolveLock.catch(() => {});
    }
    const promise = this._resolveBindingImpl(localRootPath, activate);
    this.resolveLock = promise;
    try {
      return await promise;
    } finally {
      if (this.resolveLock === promise) this.resolveLock = null;
    }
  }

  private async _resolveBindingImpl(
    localRootPath: string,
    activate: boolean
  ): Promise<ResolveBindingResult> {
    const visited = new Set<string>();
    let currentPath = path.normalize(localRootPath);
    let fallbackDbBinding: ProjectBindingDTO | null = null;
    let deferredGeneratedPath: string | null = null;

    while (currentPath && !visited.has(currentPath)) {
      visited.add(currentPath);

      if (isDerivedOutputDirectory(currentPath)) {
        deferredGeneratedPath = deferredGeneratedPath ?? currentPath;
        const parentPath = path.dirname(currentPath);
        if (!parentPath || parentPath === currentPath) {
          break;
        }
        currentPath = parentPath;
        continue;
      }

      // Second priority: local marker file.
      const marker = await this.readMarkerFile(currentPath);
      if (marker) {
        // Marker exists but DB has no record — attempt recovery from the marker.
        const recovered = await this.recoverFromMarker(currentPath, marker);
        if (recovered) {
          if (activate && recovered.enabled) {
            this.activateCollaboration(recovered);
          }
          return { found: true, binding: recovered, source: 'marker_file' };
        }
      }

      // Marker missed: remember the DB binding as a last-resort fallback.
      const dbBinding = await this.getBindingByPath(currentPath);
      if (dbBinding && !fallbackDbBinding) {
        fallbackDbBinding = dbBinding;
      }

      const parentPath = path.dirname(currentPath);
      if (!parentPath || parentPath === currentPath) {
        break;
      }
      currentPath = parentPath;
    }

    if (fallbackDbBinding) {
      if (activate && fallbackDbBinding.enabled) {
        this.activateCollaboration(fallbackDbBinding);
      }
      return { found: true, binding: fallbackDbBinding, source: 'database' };
    }

    if (deferredGeneratedPath) {
      const generatedBinding = await this.getBindingByPath(deferredGeneratedPath);
      if (generatedBinding) {
        if (activate && generatedBinding.enabled) {
          this.activateCollaboration(generatedBinding);
        }
        return { found: true, binding: generatedBinding, source: 'database' };
      }

      const generatedMarker = await this.readMarkerFile(deferredGeneratedPath);
      if (generatedMarker) {
        const recovered = await this.recoverFromMarker(deferredGeneratedPath, generatedMarker);
        if (recovered) {
          if (activate && recovered.enabled) {
            this.activateCollaboration(recovered);
          }
          return { found: true, binding: recovered, source: 'marker_file' };
        }
      }
    }

    return { found: false, binding: null, source: 'none' };
  }

  async setEnabled(projectId: string, enabled: boolean): Promise<void> {
    const db = getDatabase();
    await db
      .update(projectBindingsTable)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(projectBindingsTable.projectId, projectId));
  }

  // ====== Operations actions ======

  /**
   * Rebuild: fully recreate the local working copy from the remote project. Pulls the
   * latest snapshot and overwrites every OT-managed file in the local directory.
   */
  async rebuildWorkingCopy(params: RebuildWorkingCopyParams): Promise<RebuildWorkingCopyResult> {
    const { localRootPath } = params;
    const result: RebuildWorkingCopyResult = {
      success: true,
      filesWritten: 0,
      foldersCreated: 0,
      errors: [],
    };

    const binding = await this.getBindingByPath(localRootPath);
    if (!binding) {
      return {
        success: false,
        filesWritten: 0,
        foldersCreated: 0,
        errors: ['目录未绑定到远端项目'],
      };
    }

    this.emitStatus(localRootPath, binding.projectId, 'syncing', '正在从远端重建本地副本...');

    try {
      const otService = getServiceContainer().get<StudioOTService>(ServiceNames.STUDIO_OT);
      const snapshot = await otService.getProjectSnapshot(binding.projectId);

      // Create folders.
      for (const folder of snapshot.folders) {
        const folderPath = path.join(localRootPath, folder.folder_path);
        try {
          await fs.ensureDir(folderPath);
          result.foldersCreated++;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push(`文件夹创建失败: ${folder.folder_path} (${message})`);
        }
      }

      // Write files.
      for (const file of snapshot.files) {
        const filePath = path.join(localRootPath, file.file_path);
        try {
          await fs.ensureDir(path.dirname(filePath));
          await fs.writeFile(filePath, file.content, 'utf-8');
          result.filesWritten++;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push(`文件写入失败: ${file.file_path} (${message})`);
        }
      }

      // Refresh the sync snapshot.
      const db = getDatabase();
      await db
        .delete(syncFileSnapshotsTable)
        .where(eq(syncFileSnapshotsTable.projectId, binding.projectId));
      const textFiles = snapshot.files.map((f) => ({
        relativePath: f.file_path,
        content: f.content,
      }));
      await this.createInitialSnapshot(binding.projectId, snapshot, textFiles, []);

      // Update the lastSyncAt timestamp.
      await db
        .update(projectBindingsTable)
        .set({ lastSyncAt: new Date(), updatedAt: new Date() })
        .where(eq(projectBindingsTable.projectId, binding.projectId));

      this.emitStatus(
        localRootPath,
        binding.projectId,
        'bound',
        `本地副本重建完成: ${result.filesWritten} 文件`
      );
      logger.info(
        `Rebuild completed: ${binding.projectId} (${result.filesWritten} files, ${result.foldersCreated} folders)`
      );
    } catch (err) {
      result.success = false;
      result.errors.push(err instanceof Error ? err.message : String(err));
      this.emitStatus(localRootPath, binding.projectId, 'error', '重建失败');
    }

    return result;
  }

  /**
   * Rebind: attach a local directory to an existing remote project. Preserves the original
   * binding-identity checks; never rebind a directory to the wrong remote project.
   */
  async rebindProject(params: RebindProjectParams): Promise<RebindProjectResult> {
    const { localRootPath, remoteProjectId, backend } = params;
    const resolvedBackend = backend ?? DEFAULT_BACKEND;

    // Check for an existing binding.
    const existing = await this.getBindingByPath(localRootPath);
    if (existing) {
      // Already bound to the same project: return as-is.
      if (existing.remoteProjectId === remoteProjectId && existing.backend === resolvedBackend) {
        return { success: true, binding: existing };
      }
      // Bound to a different project: caller must unbind first.
      return {
        success: false,
        binding: null,
      };
    }

    // Verify the remote project exists.
    try {
      const otService = getServiceContainer().get<StudioOTService>(ServiceNames.STUDIO_OT);
      const snapshot = await otService.getProjectSnapshot(remoteProjectId);

      // Write marker + DB.
      const workspaceId = snapshot.project.workspace || 'private';
      await this.writeMarkerFile(localRootPath, {
        projectId: remoteProjectId,
        workspaceId,
        backend: resolvedBackend,
      });

      const db = getDatabase();
      await db.insert(projectBindingsTable).values({
        id: uuidv4(),
        projectId: remoteProjectId,
        workspaceId,
        backend: resolvedBackend,
        authority: DEFAULT_AUTHORITY,
        materialization: DEFAULT_MATERIALIZATION,
        localRootPath: path.normalize(localRootPath),
        projectName: snapshot.project.name,
        enabled: true,
        lastSyncAt: null,
        customIgnorePatterns: null,
      });

      const binding = await this.getBindingByProjectId(remoteProjectId);
      if (binding) {
        this.emitStatus(
          localRootPath,
          remoteProjectId,
          'bound',
          `重新绑定成功: ${snapshot.project.name}`
        );
        this.activateCollaboration(binding);
      }
      return { success: true, binding };
    } catch (err) {
      logger.error(`Rebind failed: ${remoteProjectId}`, err);
      return { success: false, binding: null };
    }
  }

  /**
   * Export: write a remote project snapshot to the given directory.
   */
  async exportSnapshot(params: ExportSnapshotParams): Promise<ExportSnapshotResult> {
    const { remoteProjectId, exportPath } = params;
    const result: ExportSnapshotResult = {
      success: true,
      filesExported: 0,
      exportPath,
      errors: [],
    };

    try {
      await fs.ensureDir(exportPath);

      const otService = getServiceContainer().get<StudioOTService>(ServiceNames.STUDIO_OT);
      const snapshot = await otService.getProjectSnapshot(remoteProjectId);

      // Create folders.
      for (const folder of snapshot.folders) {
        await fs.ensureDir(path.join(exportPath, folder.folder_path));
      }

      // Write files.
      for (const file of snapshot.files) {
        const filePath = path.join(exportPath, file.file_path);
        try {
          await fs.ensureDir(path.dirname(filePath));
          await fs.writeFile(filePath, file.content, 'utf-8');
          result.filesExported++;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push(`导出失败: ${file.file_path} (${message})`);
        }
      }

      logger.info(
        `Export completed: ${remoteProjectId} -> ${exportPath} (${result.filesExported} files)`
      );
    } catch (err) {
      result.success = false;
      result.errors.push(err instanceof Error ? err.message : String(err));
    }

    return result;
  }

  /**
   * Activate the collaborative state: bind writeback, external-change detection, and file
   * watching. Only one project may be active at a time.
   */
  activateCollaboration(binding: ProjectBindingDTO): void {
    if (binding.backend !== 'scipen-ot') {
      this.deactivateCollaboration();
      logger.info(`Binding activated (non-OT writeback path): ${binding.localRootPath}`);
      this.activeProjectPath = binding.localRootPath;
      return;
    }
    // Tear down any previously active project first.
    this.deactivateCollaboration();

    const localRootPath = binding.localRootPath;
    this.activeProjectPath = localRootPath;

    // 1. Start the writeback service.
    const replicaService = getReplicaWritebackService();
    replicaService.bind(localRootPath);

    // 2. Start external-change detection, sharing writeback's echoSuppressor.
    const detector = getExternalChangeDetector();
    detector.bind(localRootPath, replicaService.echoSuppressor);

    // 3. Bridge FileWorkerClient events to the external-change detector. Do not call
    //    startWatching/stopWatching here; FileSystemService owns the watcher lifecycle.
    const fileWorkerClient = getFileWorkerClient();
    this.fileChangeHandler = (event: FileChangeEvent) => {
      const changeType =
        event.type === 'add'
          ? ('created' as const)
          : event.type === 'unlink'
            ? ('deleted' as const)
            : ('modified' as const);
      void detector.reportChange(event.path, changeType);
    };
    fileWorkerClient.on('file-changed', this.fileChangeHandler);

    logger.info(`Collaborative working state activated: ${localRootPath}`);
  }

  /**
   * Deactivate the collaborative state: unbind writeback, external detection, and file
   * watching.
   */
  deactivateCollaboration(): void {
    if (!this.activeProjectPath) return;

    // Remove the FileWorkerClient listener; watcher lifecycle is owned by FileSystemService.
    if (this.fileChangeHandler) {
      const fileWorkerClient = getFileWorkerClient();
      fileWorkerClient.removeListener('file-changed', this.fileChangeHandler);
      this.fileChangeHandler = null;
    }

    // Unbind services.
    getReplicaWritebackService().unbind();
    getExternalChangeDetector().unbind();

    logger.info(`Collaborative working state deactivated: ${this.activeProjectPath}`);
    this.activeProjectPath = null;
  }

  dispose(): void {
    this.deactivateCollaboration();
    this._onStatusChanged.dispose();
  }

  // ====== Private helpers ======

  private emitStatus(
    localRootPath: string,
    projectId: string,
    status: ProjectBindingStatusEvent['status'],
    message: string
  ): void {
    this._onStatusChanged.fire({ projectId, localRootPath, status, message });
  }

  /**
   * Seed the initial sync snapshot, capturing each file's baseline at import time. Phases
   * 3/4 consume this to detect changes and conflicts.
   */
  private async createInitialSnapshot(
    projectId: string,
    otSnapshot: Awaited<ReturnType<StudioOTService['openLocalProject']>>,
    textFiles: Array<{ relativePath: string; content: string }>,
    resourceFiles: Array<{ relativePath: string; absolutePath: string }>
  ): Promise<void> {
    const db = getDatabase();

    // Build OT file path -> fileId/version lookup.
    const otFileMap = new Map<string, { id: string; version: number }>();
    for (const file of otSnapshot.files) {
      otFileMap.set(file.file_path, { id: file.id, version: file.version });
    }

    // Shared snapshot row type.
    type SnapshotRecord = {
      id: string;
      projectId: string;
      filePath: string;
      fileId: string | null;
      fileType: 'ot_text' | 'resource';
      contentHash: string;
      fileSize: number;
      otVersion: number | null;
    };

    // Text-file snapshots.
    const textSnapshots: SnapshotRecord[] = textFiles.map((f) => {
      const otFile = otFileMap.get(f.relativePath);
      return {
        id: uuidv4(),
        projectId,
        filePath: f.relativePath,
        fileId: otFile?.id ?? null,
        fileType: 'ot_text' as const,
        contentHash: computeHash(f.content),
        fileSize: Buffer.byteLength(f.content, 'utf-8'),
        otVersion: otFile?.version ?? null,
      };
    });

    // Resource-file snapshots (metadata only, contents are not uploaded).
    const resourceSnapshots: SnapshotRecord[] = [];
    for (const f of resourceFiles) {
      try {
        const stat = await fs.stat(f.absolutePath);
        const content = await fs.readFile(f.absolutePath);
        resourceSnapshots.push({
          id: uuidv4(),
          projectId,
          filePath: f.relativePath,
          fileId: null,
          fileType: 'resource' as const,
          contentHash: computeHash(content),
          fileSize: stat.size,
          otVersion: null,
        });
      } catch (err) {
        logger.warn(`Failed to read resource snapshot: ${f.absolutePath}`, err);
      }
    }

    const allSnapshots = [...textSnapshots, ...resourceSnapshots];
    if (allSnapshots.length > 0) {
      // Batch insert (SQLite caps parameters per statement at 999).
      const batchSize = 50;
      for (let i = 0; i < allSnapshots.length; i += batchSize) {
        const batch = allSnapshots.slice(i, i + batchSize);
        await db.insert(syncFileSnapshotsTable).values(batch);
      }
    }

    logger.info(
      `Initial sync snapshot created: ${textSnapshots.length} text files, ${resourceSnapshots.length} resource files`
    );
  }

  /**
   * Roll back a failed import by deleting the marker file and DB rows.
   */
  private async rollbackImport(localRootPath: string, projectId: string): Promise<void> {
    try {
      const markerPath = getMarkerPath(localRootPath);
      if (await fs.pathExists(markerPath)) {
        await fs.remove(markerPath);
      }
      const scipenDir = path.join(localRootPath, SCIPEN_DIR);
      if (await fs.pathExists(scipenDir)) {
        const remaining = await fs.readdir(scipenDir);
        if (remaining.length === 0) {
          await fs.remove(scipenDir);
        }
      }
    } catch (err) {
      logger.warn('Failed to clean marker file during rollback', err);
    }

    try {
      const db = getDatabase();
      await db
        .delete(syncFileSnapshotsTable)
        .where(eq(syncFileSnapshotsTable.projectId, projectId));
      await db.delete(projectBindingsTable).where(eq(projectBindingsTable.projectId, projectId));
    } catch (err) {
      logger.warn('Failed to clean database rows during rollback', err);
    }
  }

  /**
   * Scan the directory and partition files into OT text files and resource files.
   */
  private async scanDirectory(
    rootPath: string,
    customIgnorePatterns?: string[]
  ): Promise<{
    textFiles: Array<{ relativePath: string; content: string }>;
    resourceFiles: Array<{ relativePath: string; absolutePath: string }>;
    skipped: number;
  }> {
    const textFiles: Array<{ relativePath: string; content: string }> = [];
    const resourceFiles: Array<{ relativePath: string; absolutePath: string }> = [];
    let skipped = 0;

    const visitedDirs = new Set<string>();
    const walk = async (dir: string): Promise<void> => {
      // Cycle detection for symlinks.
      const realDir = await fs.realpath(dir).catch(() => dir);
      if (visitedDirs.has(realDir)) return;
      visitedDirs.add(realDir);

      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(rootPath, fullPath);

        if (shouldIgnore(relativePath)) {
          skipped++;
          continue;
        }

        // Custom ignore patterns.
        if (customIgnorePatterns?.some((pattern) => relativePath.includes(pattern))) {
          skipped++;
          continue;
        }

        // Skip symlinks entirely.
        if (entry.isSymbolicLink()) {
          skipped++;
          continue;
        }

        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          if (isOTManaged(fullPath)) {
            try {
              const MAX_TEXT_FILE_SIZE = 8 * 1024 * 1024; // 8MB
              const stat = await fs.stat(fullPath);
              if (stat.size > MAX_TEXT_FILE_SIZE) {
                logger.warn(
                  `Skipping oversized text file (${(stat.size / 1024 / 1024).toFixed(1)}MB): ${relativePath}`
                );
                skipped++;
                continue;
              }
              const content = await fs.readFile(fullPath, 'utf-8');
              textFiles.push({ relativePath: relativePath.replace(/\\/g, '/'), content });
            } catch (err) {
              logger.warn(`Failed to read text file: ${fullPath}`, err);
              skipped++;
            }
          } else {
            resourceFiles.push({
              relativePath: relativePath.replace(/\\/g, '/'),
              absolutePath: fullPath,
            });
          }
        }
      }
    };

    await walk(rootPath);
    return { textFiles, resourceFiles, skipped };
  }

  /**
   * Extract the folders that must be created from a list of file paths.
   */
  private extractFolders(filePaths: string[]): string[] {
    const folders = new Set<string>();
    for (const filePath of filePaths) {
      const dir = path.dirname(filePath);
      if (dir && dir !== '.') {
        // Include every ancestor directory.
        const parts = dir.split('/');
        for (let i = 1; i <= parts.length; i++) {
          folders.add(parts.slice(0, i).join('/'));
        }
      }
    }
    return Array.from(folders).sort();
  }

  /**
   * Write the .scipen/project.json marker file.
   */
  private async writeMarkerFile(
    localRootPath: string,
    data: { projectId: string; workspaceId: string; backend?: RemoteProjectBackend }
  ): Promise<void> {
    const markerPath = getMarkerPath(localRootPath);
    await fs.ensureDir(path.dirname(markerPath));

    const marker: ScipenProjectMarker = {
      schemaVersion: MARKER_SCHEMA_VERSION,
      projectId: data.projectId,
      workspaceId: data.workspaceId,
      backend: data.backend ?? DEFAULT_BACKEND,
      authority: DEFAULT_AUTHORITY,
      materialization: DEFAULT_MATERIALIZATION,
      createdAt: new Date().toISOString(),
    };

    await fs.writeJson(markerPath, marker, { spaces: 2 });
    logger.info(`Marker file written: ${markerPath}`);
  }

  /**
   * Read the .scipen/project.json marker file.
   */
  private async readMarkerFile(localRootPath: string): Promise<ScipenProjectMarker | null> {
    const markerPath = getMarkerPath(localRootPath);
    try {
      if (await fs.pathExists(markerPath)) {
        const raw = (await fs.readJson(markerPath)) as Record<string, unknown>;
        const schemaVersion = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1;
        if (schemaVersion > MARKER_SCHEMA_VERSION) {
          logger.warn(
            `Marker file schema version is too new (v${schemaVersion}); current version supports up to v${MARKER_SCHEMA_VERSION}: ${markerPath}`
          );
          return null;
        }
        return {
          schemaVersion,
          projectId: raw.projectId as string,
          workspaceId: raw.workspaceId as string,
          backend: (raw.backend as RemoteProjectBackend | undefined) ?? DEFAULT_BACKEND,
          authority: (raw.authority as RemoteProjectAuthority | undefined) ?? DEFAULT_AUTHORITY,
          materialization:
            (raw.materialization as RemoteProjectMaterialization | undefined) ??
            DEFAULT_MATERIALIZATION,
          createdAt: raw.createdAt as string,
        };
      }
    } catch (err) {
      logger.warn(`Failed to read marker file: ${markerPath}`, err);
    }
    return null;
  }

  /**
   * Recreate a DB binding row from the marker file (used when DB is missing but marker exists).
   */
  private async recoverFromMarker(
    localRootPath: string,
    marker: ScipenProjectMarker
  ): Promise<ProjectBindingDTO | null> {
    try {
      const existingBinding = await this.getBindingByProjectId(marker.projectId);
      if (existingBinding) {
        if (path.normalize(existingBinding.localRootPath) !== path.normalize(localRootPath)) {
          logger.info(
            `Marker project ${marker.projectId} is already bound; reusing existing root: ${existingBinding.localRootPath}`
          );
        }
        return existingBinding;
      }

      const markerBackend = marker.backend ?? DEFAULT_BACKEND;
      let projectName = path.basename(localRootPath);

      // Only the scipen-ot backend confirms the cloud project still exists via OT.
      if (markerBackend === 'scipen-ot') {
        const otService = getServiceContainer().get<StudioOTService>(ServiceNames.STUDIO_OT);
        const snapshot = await otService.getProjectSnapshot(marker.projectId);
        projectName = snapshot.project.name;
      }

      const db = getDatabase();
      const bindingId = uuidv4();
      const normalized = path.normalize(localRootPath);

      await db.insert(projectBindingsTable).values({
        id: bindingId,
        projectId: marker.projectId,
        workspaceId: marker.workspaceId,
        backend: markerBackend,
        authority: marker.authority ?? DEFAULT_AUTHORITY,
        materialization: marker.materialization ?? DEFAULT_MATERIALIZATION,
        localRootPath: normalized,
        projectName,
        enabled: true,
        lastSyncAt: null,
        customIgnorePatterns: null,
      });

      logger.info(`Recovered binding from marker: ${marker.projectId} -> ${localRootPath}`);
      return this.getBindingByProjectId(marker.projectId);
    } catch (err) {
      logger.warn(
        `Failed to recover binding from marker (remote project may no longer exist): ${marker.projectId}`,
        err
      );
      return null;
    }
  }
}
