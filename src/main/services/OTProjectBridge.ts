/**
 * @file OTProjectBridge - adapts StudioOTService to the RemoteProjectBridge interface.
 * @description Exposes StudioOTService through the unified Bridge shape, keeping underlying
 *   OT semantics unchanged and only remapping method signatures.
 */

import { Emitter, type Event } from '../../../shared/utils';
import type { StudioOTService } from './StudioOTService';
import type {
  IRemoteProjectBridge,
  BridgeConnectionStateDTO,
  BridgeProjectSnapshot,
  BridgeDocumentState,
  BridgeFileEntry,
  BridgeFolderEntry,
  BridgeRemotePatchEvent,
  BridgeTreeChangeEvent,
  BridgeSubmitOpsParams,
  BridgeSubmitOpsResult,
  BridgeCreateFileParams,
  BridgeCreateFolderParams,
  BridgeRenameParams,
  BridgeDeleteParams,
  BridgeMoveParams,
} from './interfaces/IRemoteProjectBridge';
import type { IDisposable } from './ServiceContainer';

export class OTProjectBridge implements IRemoteProjectBridge {
  readonly backend = 'scipen-ot' as const;

  private readonly _onRemotePatch = new Emitter<BridgeRemotePatchEvent>();
  readonly onRemotePatch: Event<BridgeRemotePatchEvent> = this._onRemotePatch.event;

  private readonly _onTreeChanged = new Emitter<BridgeTreeChangeEvent>();
  readonly onTreeChanged: Event<BridgeTreeChangeEvent> = this._onTreeChanged.event;

  private readonly _onConnectionChanged = new Emitter<BridgeConnectionStateDTO>();
  readonly onConnectionChanged: Event<BridgeConnectionStateDTO> = this._onConnectionChanged.event;

  private readonly disposables: IDisposable[] = [];

  constructor(private readonly ot: StudioOTService) {
    this.disposables.push(
      ot.onDidReceiveRemoteUpdate((update) => {
        this._onRemotePatch.fire({
          projectId: update.projectId,
          fileId: update.fileId,
          filePath: update.filePath,
          content: update.content,
          version: update.version,
        });
      })
    );

    this.disposables.push(
      ot.onDidReceiveFileEvent((event) => {
        this._onTreeChanged.fire({
          projectId: event.projectId,
          action: event.action,
          entityType: event.entityType,
          entityId: event.fileId ?? event.folderId,
          filePath: event.filePath,
        });
      })
    );

    this.disposables.push(
      ot.onDidChangeConnection((state) => {
        this._onConnectionChanged.fire({
          state: state.state,
          projectId: null,
        });
      })
    );
  }

  // ====== Connection management ======

  async connectProject(config: Record<string, unknown>): Promise<BridgeConnectionStateDTO> {
    const result = await this.ot.configure(
      config as unknown as Parameters<StudioOTService['configure']>[0]
    );
    return { state: result.state, projectId: null };
  }

  disconnectProject(): void {
    this.ot.disconnect();
  }

  // ====== Project snapshot ======

  async getProjectSnapshot(projectId: string): Promise<BridgeProjectSnapshot | null> {
    const snapshot = await this.ot.getProjectSnapshot(projectId);
    return {
      projectId: snapshot.project.id,
      projectName: snapshot.project.name,
      files: snapshot.files.map((f) => ({
        id: f.id,
        filePath: f.file_path,
        content: f.content,
        version: f.version,
      })),
      folders: snapshot.folders.map((f) => ({
        id: f.id,
        folderPath: f.folder_path,
      })),
    };
  }

  // ====== Document session ======

  async joinDocument(projectId: string, fileId: string): Promise<BridgeDocumentState> {
    const file = await this.ot.joinFile({ projectId, fileId });
    return {
      projectId,
      fileId: file.id,
      content: file.content,
      version: file.version,
    };
  }

  leaveDocument(_projectId: string, _fileId: string): void {
    // The OT protocol has no explicit leaveFile; disconnect releases resources implicitly.
  }

  // ====== Op submission ======

  async submitOps(params: BridgeSubmitOpsParams): Promise<BridgeSubmitOpsResult> {
    const result = await this.ot.submitForegroundFileOp({
      projectId: params.projectId,
      fileId: params.fileId,
      version: params.version,
      ops: params.ops as Parameters<StudioOTService['submitForegroundFileOp']>[0]['ops'],
    });
    return { version: result.version };
  }

  // ====== File tree operations ======

  async createFile(params: BridgeCreateFileParams): Promise<BridgeFileEntry> {
    const file = await this.ot.createFile({
      projectId: params.projectId,
      file_path: params.filePath,
      content: params.content,
    });
    return { id: file.id, filePath: file.file_path, content: file.content, version: file.version };
  }

  async createFolder(params: BridgeCreateFolderParams): Promise<BridgeFolderEntry> {
    const folder = await this.ot.createFolder({
      projectId: params.projectId,
      folder_path: params.folderPath,
    });
    return { id: folder.id, folderPath: folder.folder_path };
  }

  async renameEntity(params: BridgeRenameParams): Promise<{ success: boolean }> {
    if (params.entityType === 'folder') {
      await this.ot.renameFolder({
        projectId: params.projectId,
        folderId: params.entityId,
        folder_path: params.newPath,
      });
      return { success: true };
    }
    // Try file first; fall back to folder only on 404/not_found.
    try {
      await this.ot.renameFile({
        projectId: params.projectId,
        fileId: params.entityId,
        file_path: params.newPath,
      });
      return { success: true };
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      if (status === 404) {
        await this.ot.renameFolder({
          projectId: params.projectId,
          folderId: params.entityId,
          folder_path: params.newPath,
        });
        return { success: true };
      }
      throw err;
    }
  }

  async moveEntity(_params: BridgeMoveParams): Promise<{ success: boolean }> {
    throw new Error('OT 后端不支持 move 操作，请使用 renameEntity 改变路径');
  }

  async deleteEntity(params: BridgeDeleteParams): Promise<{ success: boolean }> {
    if (params.entityType === 'folder') {
      return await this.ot.deleteFolder(params.projectId, params.entityId);
    }
    try {
      return await this.ot.deleteFile(params.projectId, params.entityId);
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      if (status === 404) {
        return await this.ot.deleteFolder(params.projectId, params.entityId);
      }
      throw err;
    }
  }

  // ====== Lifecycle ======

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this._onRemotePatch.dispose();
    this._onTreeChanged.dispose();
    this._onConnectionChanged.dispose();
  }
}
