/**
 * @file UpdateService - Application auto-update service
 * @description Wraps electron-updater and exposes check/download/install capabilities.
 *   Maintains status and emitter only; does not touch BrowserWindow directly.
 * @depends electron-updater, electron (app)
 */

import { app } from 'electron';
import pkg from 'electron-updater';
const { autoUpdater } = pkg;
type ElectronUpdateInfo = pkg.UpdateInfo;
type ProgressInfo = pkg.ProgressInfo;
import { Emitter, type Event } from '../../../shared/utils';
import type { UpdateStatus, UpdateInfo } from '../../../shared/ipc/app-contract';
import { createLogger } from './LoggerService';

const logger = createLogger('UpdateService');

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const INITIAL_CHECK_DELAY_MS = 60 * 1000; // 60 seconds after launch

function normalizeReleaseNotes(notes: ElectronUpdateInfo['releaseNotes']): string {
  if (!notes) return '';
  if (typeof notes === 'string') return notes;
  if (Array.isArray(notes)) {
    return notes
      .map((n) => (typeof n === 'string' ? n : n.note || ''))
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

function toUpdateInfo(info: ElectronUpdateInfo): UpdateInfo {
  return {
    version: info.version,
    releaseNotes: normalizeReleaseNotes(info.releaseNotes),
    releaseDate: info.releaseDate,
  };
}

export class UpdateService {
  private _status: UpdateStatus = {
    state: 'idle',
    currentVersion: app.getVersion(),
  };

  private readonly _onDidChangeStatus = new Emitter<UpdateStatus>();
  readonly onDidChangeStatus: Event<UpdateStatus> = this._onDidChangeStatus.event;

  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    if (!app.isPackaged) {
      logger.info('Development mode detected, skipping auto-update initialization');
      return;
    }

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
      this.updateState({ state: 'checking' });
    });

    autoUpdater.on('update-available', (info: ElectronUpdateInfo) => {
      this.updateState({ state: 'available', info: toUpdateInfo(info) });
    });

    autoUpdater.on('update-not-available', () => {
      this.updateState({ state: 'not-available' });
    });

    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      this.updateState({
        state: 'downloading',
        progress: {
          percent: progress.percent,
          bytesPerSecond: progress.bytesPerSecond,
          total: progress.total,
          transferred: progress.transferred,
        },
      });
    });

    autoUpdater.on('update-downloaded', (info: ElectronUpdateInfo) => {
      this.updateState({ state: 'downloaded', info: toUpdateInfo(info) });
    });

    autoUpdater.on('error', (error: Error) => {
      logger.error('Auto-update error:', error.message);
      this.updateState({ state: 'error', error: error.message });
    });

    this.scheduleChecks();
  }

  get status(): UpdateStatus {
    return { ...this._status };
  }

  async checkForUpdates(): Promise<UpdateStatus> {
    if (!app.isPackaged) {
      return { ...this._status, state: 'not-available' };
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.updateState({ state: 'error', error: msg });
    }
    return this.status;
  }

  async downloadUpdate(): Promise<void> {
    if (!app.isPackaged) return;
    await autoUpdater.downloadUpdate();
  }

  installUpdate(): void {
    if (!app.isPackaged) return;
    autoUpdater.quitAndInstall(false, true);
  }

  dispose(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    this._onDidChangeStatus.dispose();
  }

  private updateState(partial: Partial<UpdateStatus>): void {
    this._status = {
      ...this._status,
      ...partial,
      currentVersion: app.getVersion(),
    };
    this._onDidChangeStatus.fire(this._status);
  }

  private scheduleChecks(): void {
    this.initialTimer = setTimeout(() => {
      void this.checkForUpdates();
    }, INITIAL_CHECK_DELAY_MS);

    this.checkTimer = setInterval(() => {
      void this.checkForUpdates();
    }, CHECK_INTERVAL_MS);
  }
}
