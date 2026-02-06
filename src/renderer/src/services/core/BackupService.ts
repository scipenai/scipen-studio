/**
 * @file BackupService.ts - Crash Recovery Backup Service
 * @description Automatically backs up dirty files to prevent data loss on crash, supports delayed scheduling and version tracking
 * @depends WorkingCopyService, FileSystemService
 */

import {
  Delayer,
  DisposableStore,
  Emitter,
  type Event,
  type IDisposable,
  Throttler,
} from '../../../../../shared/utils';
import { api } from '../../api';
import { createLogger } from '../LogService';
import { ElectronFileSystem, type IFileSystem } from './FileSystemService';
import { getWorkingCopyService } from './WorkingCopyService';

const logger = createLogger('BackupService');

// ====== Type Definitions ======

export interface BackupMeta {
  path: string;
  timestamp: number;
  hash: string;
}

interface BackupData {
  meta: BackupMeta;
  content: string;
}

// ====== BackupService Implementation ======

export class BackupService implements IDisposable {
  private readonly _disposables = new DisposableStore();

  private readonly _fileSystem: IFileSystem;

  private readonly _backupDelayers = new Map<string, Delayer<void>>();

  /**
   * Write throttler - ensures backup writes execute serially
   *
   * Using Throttler instead of a simple queue because:
   * 1. Auto-merges high-frequency triggers: if a write is in progress, subsequent triggers queue
   * 2. Keeps only the latest task: avoids unnecessary old version writes
   * 3. Auto error propagation: returns failed Promise when task fails
   *
   * This prevents I/O contention and potential filesystem errors when multiple files write simultaneously
   */
  private readonly _writeThrottler = new Throttler();

  private readonly _contentVersions = new Map<string, number>();

  private readonly _backedUpVersions = new Map<string, number>();

  private readonly _backupDelay = 5000;

  private readonly _backupDir = '.scipen/backups';

  private _suspended = false;

  private _appDataDir: string | null = null;

  // ====== Event Definitions ======

  private readonly _onDidBackup = new Emitter<string>();
  readonly onDidBackup: Event<string> = this._onDidBackup.event;

  private readonly _onDidRestore = new Emitter<string>();
  readonly onDidRestore: Event<string> = this._onDidRestore.event;

  private readonly _onDidDiscard = new Emitter<string>();
  readonly onDidDiscard: Event<string> = this._onDidDiscard.event;

  constructor(fileSystem?: IFileSystem) {
    this._fileSystem = fileSystem ?? new ElectronFileSystem();
    this._disposables.add(this._onDidBackup);
    this._disposables.add(this._onDidRestore);
    this._disposables.add(this._onDidDiscard);

    this._initAppDataDir();
  }

  private async _initAppDataDir(): Promise<void> {
    try {
      this._appDataDir = await api.app.getAppDataDir();
      logger.debug(`AppDataDir initialized: ${this._appDataDir}`);
    } catch (error) {
      logger.warn('Failed to get appDataDir, remote backups will be disabled', error);
    }
  }

  // ====== Core Methods ======

  /**
   * Schedule backup (delayed execution to prevent frequent writes)
   *
   * Following VS Code design: Delayer.trigger() returns a Promise that gets rejected on cancel(),
   * we need to catch this error here to avoid unhandled promise rejections.
   */
  scheduleBackup(path: string, content: string, projectPath: string): void {
    if (this._suspended) {
      logger.debug(`Suspended, ignoring backup for ${path}`);
      return;
    }

    const currentVersion = (this._contentVersions.get(path) ?? 0) + 1;
    this._contentVersions.set(path, currentVersion);

    let delayer = this._backupDelayers.get(path);
    if (!delayer) {
      delayer = new Delayer(this._backupDelay);
      this._backupDelayers.set(path, delayer);
    }

    delayer
      .trigger(() => this._doBackup(path, content, projectPath, currentVersion))
      .catch((error) => {
        if (error?.name !== 'CancellationError') {
          logger.warn(`Backup scheduling failed for ${path}:`, error);
        }
      });
  }

  async backup(path: string, content: string, projectPath: string): Promise<void> {
    const delayer = this._backupDelayers.get(path);
    if (delayer) {
      delayer.cancel();
    }
    const version = this._contentVersions.get(path) ?? 0;
    await this._doBackup(path, content, projectPath, version);
  }

  private async _doBackup(
    path: string,
    content: string,
    projectPath: string,
    version: number
  ): Promise<void> {
    if (this._suspended) {
      return;
    }

    const workingCopy = getWorkingCopyService().get(path);
    if (!workingCopy?.isDirty) {
      logger.debug(`File not dirty, skipping backup: ${path}`);
      return;
    }

    const backedUpVersion = this._backedUpVersions.get(path);
    if (backedUpVersion !== undefined && backedUpVersion >= version) {
      logger.debug(`Version already backed up: ${path}`);
      return;
    }

    try {
      const backupPath = this._getBackupPath(path, projectPath);
      if (!backupPath) {
        logger.debug(`Backup path unavailable for ${path}, skipping`);
        return;
      }

      const data: BackupData = {
        meta: {
          path,
          timestamp: Date.now(),
          hash: this._hashContent(content),
        },
        content,
      };

      await this._writeThrottler.queue(async () => {
        const backupDir = backupPath.substring(0, backupPath.lastIndexOf('/'));
        await this._fileSystem.ensureDir(backupDir);
        await this._fileSystem.writeFile(backupPath, JSON.stringify(data));
      });

      this._backedUpVersions.set(path, version);

      this._onDidBackup.fire(path);
      logger.debug(`Backed up: ${path} (v${version})`);
    } catch (error) {
      logger.error(`Backup failed for ${path}`, error);
    }
  }

  async restore(path: string, projectPath: string): Promise<string | null> {
    try {
      const backupPath = this._getBackupPath(path, projectPath);
      if (!backupPath) return null;

      const exists = await this._fileSystem.pathExists(backupPath);
      if (!exists) return null;

      const rawData = await this._fileSystem.readFile(backupPath);
      if (!rawData) return null;

      const data: BackupData = JSON.parse(rawData);

      if (data.meta.hash !== this._hashContent(data.content)) {
        logger.warn(`Backup hash mismatch for ${path}`);
        return null;
      }

      this._onDidRestore.fire(path);
      logger.info(`Restored: ${path}`);

      return data.content;
    } catch (error) {
      logger.warn(`Failed to restore backup for ${path}`, error);
      return null;
    }
  }

  async hasBackup(path: string, projectPath: string): Promise<boolean> {
    try {
      const backupPath = this._getBackupPath(path, projectPath);
      if (!backupPath) return false;

      return await this._fileSystem.pathExists(backupPath);
    } catch (error) {
      logger.warn(`Failed to check backup existence for ${path}`, error);
      return false;
    }
  }

  async discardBackup(path: string, projectPath: string): Promise<void> {
    const delayer = this._backupDelayers.get(path);
    if (delayer) {
      try {
        delayer.cancel();
      } catch {
        // Ignore cancellation errors
      }
      this._backupDelayers.delete(path);
    }

    this._contentVersions.delete(path);
    this._backedUpVersions.delete(path);

    try {
      const backupPath = this._getBackupPath(path, projectPath);
      if (backupPath) {
        const exists = await this._fileSystem.pathExists(backupPath);
        if (exists) {
          await this._fileSystem.deleteFile(backupPath);
        }
      }

      this._onDidDiscard.fire(path);
      logger.debug(`Discarded backup: ${path}`);
    } catch (error) {
      logger.warn(`Failed to discard backup for ${path}`, error);
    }
  }

  suspend(): void {
    this._suspended = true;
    for (const delayer of this._backupDelayers.values()) {
      delayer.cancel();
    }
    logger.info('Suspended');
  }

  resume(): void {
    this._suspended = false;
    logger.info('Resumed');
  }

  // ====== Helper Methods ======

  private _isRemotePath(path: string): boolean {
    return path.startsWith('overleaf://') || path.startsWith('overleaf:');
  }

  private _getBackupPath(path: string, projectPath: string): string | null {
    const hash = this._hashPath(path);

    if (this._isRemotePath(projectPath)) {
      if (!this._appDataDir) {
        logger.debug('AppDataDir not initialized, skipping remote backup');
        return null;
      }
      const projectId = projectPath
        .replace(/^overleaf:\/\//, '')
        .replace(/^overleaf:/, '')
        .split('/')[0];
      return `${this._appDataDir}/remote-backups/${projectId}/${hash}.backup`;
    }

    return `${projectPath}/${this._backupDir}/${hash}.backup`;
  }

  private _hashPath(path: string): string {
    let hash = 0;
    for (let i = 0; i < path.length; i++) {
      hash = (hash << 5) - hash + path.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
  }

  private _hashContent(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      hash = (hash << 5) - hash + content.charCodeAt(i);
      hash |= 0;
    }
    return hash.toString(16);
  }

  // ====== Lifecycle ======

  dispose(): void {
    this._suspended = true;
    for (const delayer of this._backupDelayers.values()) {
      delayer.dispose();
    }
    this._backupDelayers.clear();
    this._contentVersions.clear();
    this._backedUpVersions.clear();
    this._writeThrottler.dispose();
    this._disposables.dispose();
  }
}

// ====== Lazy Service Getter ======

let _backupService: BackupService | null = null;

export function getBackupService(): BackupService {
  if (!_backupService) {
    const { getServices } = require('./ServiceRegistry');
    _backupService = getServices().backup;
  }
  return _backupService!;
}

export function _setBackupServiceInstance(instance: BackupService): void {
  _backupService = instance;
}
