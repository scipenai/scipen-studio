/**
 * @file WorkingCopyService.ts - Dirty File Tracking Service
 * @description Tracks file original and current content, determines if there are unsaved modifications
 * @depends shared/utils (Emitter, Event)
 */

import {
  DisposableStore,
  Emitter,
  type Event,
  type IDisposable,
} from '../../../../../shared/utils';

// ============ Type Definitions ============

export interface IWorkingCopy {
  readonly path: string;
  content: string;
  originalContent: string;
  readonly isDirty: boolean;
  lastModified: number;
}

export interface WorkingCopyChangeEvent {
  readonly path: string;
  readonly workingCopy: IWorkingCopy;
  readonly type: 'register' | 'unregister' | 'dirty' | 'content' | 'save';
}

// ============ WorkingCopyService Implementation ============

export class WorkingCopyService implements IDisposable {
  private readonly _disposables = new DisposableStore();
  private readonly _workingCopies = new Map<string, WorkingCopyImpl>();

  // ============ Event Definitions ============

  private readonly _onDidRegister = new Emitter<IWorkingCopy>();
  readonly onDidRegister: Event<IWorkingCopy> = this._onDidRegister.event;

  private readonly _onDidUnregister = new Emitter<IWorkingCopy>();
  readonly onDidUnregister: Event<IWorkingCopy> = this._onDidUnregister.event;

  private readonly _onDidChangeDirty = new Emitter<IWorkingCopy>();
  readonly onDidChangeDirty: Event<IWorkingCopy> = this._onDidChangeDirty.event;

  private readonly _onDidChangeContent = new Emitter<IWorkingCopy>();
  readonly onDidChangeContent: Event<IWorkingCopy> = this._onDidChangeContent.event;

  private readonly _onDidSave = new Emitter<IWorkingCopy>();
  readonly onDidSave: Event<IWorkingCopy> = this._onDidSave.event;

  constructor() {
    this._disposables.add(this._onDidRegister);
    this._disposables.add(this._onDidUnregister);
    this._disposables.add(this._onDidChangeDirty);
    this._disposables.add(this._onDidChangeContent);
    this._disposables.add(this._onDidSave);
  }

  // ============ Getters ============

  get dirtyCount(): number {
    let count = 0;
    for (const copy of this._workingCopies.values()) {
      if (copy.isDirty) count++;
    }
    return count;
  }

  get dirtyWorkingCopies(): IWorkingCopy[] {
    return Array.from(this._workingCopies.values()).filter((c) => c.isDirty);
  }

  get hasDirty(): boolean {
    for (const copy of this._workingCopies.values()) {
      if (copy.isDirty) return true;
    }
    return false;
  }

  get workingCopies(): IWorkingCopy[] {
    return Array.from(this._workingCopies.values());
  }

  // ============ Core Methods ============

  /**
   * Register a working copy (called when opening a file)
   */
  register(path: string, content: string): IWorkingCopy {
    let copy = this._workingCopies.get(path);

    if (copy) {
      copy.originalContent = content;
      copy.content = content;
      copy.lastModified = Date.now();
      return copy;
    }

    copy = new WorkingCopyImpl(path, content);
    this._workingCopies.set(path, copy);
    this._onDidRegister.fire(copy);

    return copy;
  }

  /**
   * Unregister a working copy (called when closing a file)
   */
  unregister(path: string): void {
    const copy = this._workingCopies.get(path);
    if (copy) {
      this._workingCopies.delete(path);
      this._onDidUnregister.fire(copy);
    }
  }

  /**
   * Get working copy
   */
  get(path: string): IWorkingCopy | undefined {
    return this._workingCopies.get(path);
  }

  /**
   * Check if working copy exists
   */
  has(path: string): boolean {
    return this._workingCopies.has(path);
  }

  /**
   * Check if file is dirty
   */
  isDirty(path: string): boolean {
    const copy = this._workingCopies.get(path);
    return copy?.isDirty ?? false;
  }

  /**
   * Update content (called when editing)
   */
  update(path: string, content: string): void {
    const copy = this._workingCopies.get(path);
    if (!copy) return;

    const wasDirty = copy.isDirty;
    copy.content = content;
    copy.lastModified = Date.now();

    this._onDidChangeContent.fire(copy);

    if (wasDirty !== copy.isDirty) {
      this._onDidChangeDirty.fire(copy);
    }
  }

  /**
   * Mark as saved
   */
  markSaved(path: string, savedContent?: string): void {
    const copy = this._workingCopies.get(path);
    if (!copy) return;

    const wasDirty = copy.isDirty;
    copy.originalContent = savedContent ?? copy.content;
    copy.lastModified = Date.now();

    this._onDidSave.fire(copy);

    if (wasDirty && !copy.isDirty) {
      this._onDidChangeDirty.fire(copy);
    }
  }

  /**
   * Revert to original content
   */
  revert(path: string): void {
    const copy = this._workingCopies.get(path);
    if (!copy) return;

    const wasDirty = copy.isDirty;
    copy.content = copy.originalContent;
    copy.lastModified = Date.now();

    this._onDidChangeContent.fire(copy);

    if (wasDirty) {
      this._onDidChangeDirty.fire(copy);
    }
  }

  /**
   * Get all dirty file paths
   */
  getDirtyPaths(): string[] {
    return this.dirtyWorkingCopies.map((c) => c.path);
  }

  // ============ Lifecycle ============

  dispose(): void {
    this._workingCopies.clear();
    this._disposables.dispose();
  }
}

// ====== WorkingCopy Implementation ======

class WorkingCopyImpl implements IWorkingCopy {
  readonly path: string;
  content: string;
  originalContent: string;
  lastModified: number;

  constructor(path: string, content: string) {
    this.path = path;
    this.content = content;
    this.originalContent = content;
    this.lastModified = Date.now();
  }

  get isDirty(): boolean {
    return this.content !== this.originalContent;
  }
}

// ====== Lazy Service Access ======

let _workingCopyService: WorkingCopyService | null = null;

export function getWorkingCopyService(): WorkingCopyService {
  if (!_workingCopyService) {
    const { getServices } = require('./ServiceRegistry');
    _workingCopyService = getServices().workingCopy;
  }
  return _workingCopyService!;
}

export function _setWorkingCopyServiceInstance(instance: WorkingCopyService): void {
  _workingCopyService = instance;
}
