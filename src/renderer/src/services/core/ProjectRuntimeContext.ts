/**
 * @file ProjectRuntimeContext.ts - Project runtime context (in-memory, not persisted)
 * @description Holds project-scoped runtime state (projectId, fileId, rootPath, etc.),
 *   decoupled from user settings in SettingsService to avoid races, stale localStorage
 *   data, and unnecessary global broadcasts.
 */

import { Emitter, type IDisposable } from '../../../../../shared/utils';
import { createLogger } from '../LogService';

const logger = createLogger('ProjectRuntimeContext');

// ====== State Interface ======

export type BootstrapState = 'idle' | 'booting' | 'ready' | 'failed';

export interface ProjectRuntimeState {
  /** Bootstrap lifecycle: idle→booting→ready/failed. Messages may only be sent when ready. */
  bootstrapState: BootstrapState;
  /** OT collaboration project id */
  projectId: string;
  /** OT id of the active file */
  fileId: string;
  /** Local root path of the current project */
  rootPath: string;
  /** IM bot user id (used to distinguish user vs bot messages) */
  botUserId: string;
  /** Overleaf remote project id */
  overleafProjectId: string;
  /** Local relative path → Overleaf docId map */
  overleafDocMap: Record<string, string>;
  /** Overleaf server URL */
  overleafServerUrl: string;
}

const EMPTY_STATE: Readonly<ProjectRuntimeState> = Object.freeze({
  bootstrapState: 'idle' as BootstrapState,
  projectId: '',
  fileId: '',
  rootPath: '',
  botUserId: '',
  overleafProjectId: '',
  overleafDocMap: Object.freeze({}) as Record<string, string>,
  overleafServerUrl: '',
});

// ====== Service Implementation ======

export class ProjectRuntimeContext implements IDisposable {
  private _state: ProjectRuntimeState = { ...EMPTY_STATE, overleafDocMap: {} };

  private readonly _onDidChange = new Emitter<ProjectRuntimeState>();
  readonly onDidChange = this._onDidChange.event;

  // ── Convenience getters ──

  get state(): Readonly<ProjectRuntimeState> {
    return this._state;
  }

  get bootstrapState(): BootstrapState {
    return this._state.bootstrapState;
  }

  get isReady(): boolean {
    return this._state.bootstrapState === 'ready';
  }

  get projectId(): string {
    return this._state.projectId;
  }

  get fileId(): string {
    return this._state.fileId;
  }

  get rootPath(): string {
    return this._state.rootPath;
  }

  get botUserId(): string {
    return this._state.botUserId;
  }

  get overleafProjectId(): string {
    return this._state.overleafProjectId;
  }

  get overleafDocMap(): Readonly<Record<string, string>> {
    return this._state.overleafDocMap;
  }

  get overleafServerUrl(): string {
    return this._state.overleafServerUrl;
  }

  // ── Mutations ──

  /** Shallow-merge update. No event is fired when values are unchanged. */
  update(partial: Partial<ProjectRuntimeState>): void {
    let changed = false;
    for (const key of Object.keys(partial) as (keyof ProjectRuntimeState)[]) {
      const newVal = partial[key];
      if (newVal !== undefined && this._state[key] !== newVal) {
        changed = true;
        break;
      }
    }
    if (!changed) return;

    this._state = { ...this._state, ...partial };
    logger.info('State updated:', Object.keys(partial).join(', '));
    this._onDidChange.fire(this._state);
  }

  /** Reset all runtime state (called on project switch). */
  reset(): void {
    this._state = { ...EMPTY_STATE, overleafDocMap: {} };
    logger.info('State reset');
    this._onDidChange.fire(this._state);
  }

  // ── Overleaf docMap atomic operations ──

  patchOverleafDocMapEntry(relativePath: string, docId: string): void {
    const updated = { ...this._state.overleafDocMap, [relativePath]: docId };
    this.update({ overleafDocMap: updated });
  }

  removeOverleafDocMapEntry(relativePath: string): void {
    if (!(relativePath in this._state.overleafDocMap)) return;
    const updated = { ...this._state.overleafDocMap };
    delete updated[relativePath];
    this.update({ overleafDocMap: updated });
  }

  renameOverleafDocMapEntry(oldPath: string, newPath: string): void {
    const docId = this._state.overleafDocMap[oldPath];
    if (!docId) return;
    const updated = { ...this._state.overleafDocMap };
    delete updated[oldPath];
    updated[newPath] = docId;
    this.update({ overleafDocMap: updated });
  }

  // ── Lifecycle ──

  dispose(): void {
    this._onDidChange.dispose();
  }
}
