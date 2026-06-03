/**
 * @file ServiceRegistry.ts - Service Registry
 * @description Unified management of service registration, retrieval and lifecycle
 * @depends EditorService, ProjectService, SettingsService, CompileService
 */

import { DisposableStore, type IDisposable } from '../../../../../shared/utils';
import { CommandServiceImpl, _setCommandServiceInstance } from '../CommandService';
import {
  InlineCompletionService,
  _setInlineCompletionServiceInstance,
} from '../InlineCompletionService';
import { KeybindingServiceImpl, _setKeybindingServiceInstance } from '../KeybindingService';
import { StorageService, _setStorageServiceInstance } from '../StorageService';
import { BackupService, _setBackupServiceInstance } from './BackupService';
import { CompileService, _setCompileServiceInstance } from './CompileService';
import { EditorService } from './EditorService';
import { ProjectService } from './ProjectService';
import { SettingsService } from './SettingsService';
import { UIService } from './UIService';
import { MarkdownRenderService } from './MarkdownRenderService';
import { WorkingCopyService, _setWorkingCopyServiceInstance } from './WorkingCopyService';
import { ProjectRuntimeContext } from './ProjectRuntimeContext';

// ====== Service Interface ======

export interface IServiceRegistry extends IDisposable {
  readonly storage: StorageService;
  readonly editor: EditorService;
  readonly project: ProjectService;
  readonly ui: UIService;
  readonly settings: SettingsService;
  readonly runtime: ProjectRuntimeContext;
  readonly workingCopy: WorkingCopyService;
  readonly backup: BackupService;
  readonly compile: CompileService;
  readonly command: CommandServiceImpl;
  readonly keybinding: KeybindingServiceImpl;
  readonly inlineCompletion: InlineCompletionService;
  readonly markdownRender: MarkdownRenderService;
}

// ====== Singleton Instance ======

let Instance: ServiceRegistry | null = null;

// ====== ServiceRegistry Implementation ======

export class ServiceRegistry implements IServiceRegistry {
  private readonly _disposables = new DisposableStore();

  readonly storage: StorageService;
  readonly editor: EditorService;
  readonly project: ProjectService;
  readonly ui: UIService;
  readonly settings: SettingsService;
  readonly runtime: ProjectRuntimeContext;
  readonly workingCopy: WorkingCopyService;
  readonly backup: BackupService;
  readonly compile: CompileService;
  readonly command: CommandServiceImpl;
  readonly keybinding: KeybindingServiceImpl;
  readonly inlineCompletion: InlineCompletionService;
  readonly markdownRender: MarkdownRenderService;

  private constructor() {
    // StorageService must be created first as other services depend on it
    this.storage = new StorageService();
    _setStorageServiceInstance(this.storage);

    this.editor = new EditorService();
    this.project = ProjectService.getInstance();
    this.ui = new UIService();
    this.settings = new SettingsService();

    // Project runtime context (in-memory, not persisted)
    this.runtime = new ProjectRuntimeContext();

    this.workingCopy = new WorkingCopyService();
    this.backup = new BackupService();
    this.compile = new CompileService();
    _setWorkingCopyServiceInstance(this.workingCopy);
    _setBackupServiceInstance(this.backup);
    _setCompileServiceInstance(this.compile);

    this.command = new CommandServiceImpl();
    this.keybinding = new KeybindingServiceImpl();

    // Set global refs for lazy getter functions
    _setCommandServiceInstance(this.command);
    _setKeybindingServiceInstance(this.keybinding);

    this.inlineCompletion = new InlineCompletionService();
    _setInlineCompletionServiceInstance(this.inlineCompletion);

    this.markdownRender = new MarkdownRenderService();

    // Register all services to disposables for unified lifecycle management
    this._disposables.add(this.storage);
    this._disposables.add(this.editor);
    this._disposables.add(this.project);
    this._disposables.add(this.ui);
    this._disposables.add(this.settings);
    this._disposables.add(this.runtime);
    this._disposables.add(this.workingCopy);
    this._disposables.add(this.backup);
    this._disposables.add(this.compile);
    this._disposables.add(this.command);
    this._disposables.add(this.keybinding);
    this._disposables.add(this.inlineCompletion);
    this._disposables.add(this.markdownRender);
  }

  static getInstance(): ServiceRegistry {
    if (!Instance) {
      Instance = new ServiceRegistry();
    }
    return Instance;
  }

  /**
   * Reset service registry (for testing only)
   * @sideeffect Disposes all services and clears singleton
   */
  static reset(): void {
    if (Instance) {
      Instance.dispose();
      Instance = null;
    }
  }

  dispose(): void {
    this._disposables.dispose();
    Instance = null;
  }
}

// ====== Convenience Accessor Functions ======

export function getServices(): IServiceRegistry {
  return ServiceRegistry.getInstance();
}

export function getStorageService(): StorageService {
  return ServiceRegistry.getInstance().storage;
}

export function getEditorService(): EditorService {
  return ServiceRegistry.getInstance().editor;
}

export function getProjectService(): ProjectService {
  return ServiceRegistry.getInstance().project;
}

export function getUIService(): UIService {
  return ServiceRegistry.getInstance().ui;
}

export function getSettingsService(): SettingsService {
  return ServiceRegistry.getInstance().settings;
}

export function getWorkingCopyService(): WorkingCopyService {
  return ServiceRegistry.getInstance().workingCopy;
}

export function getBackupService(): BackupService {
  return ServiceRegistry.getInstance().backup;
}

export function getCompileService(): CompileService {
  return ServiceRegistry.getInstance().compile;
}

export function getCommandService(): CommandServiceImpl {
  return ServiceRegistry.getInstance().command;
}

export function getKeybindingService(): KeybindingServiceImpl {
  return ServiceRegistry.getInstance().keybinding;
}

export function getInlineCompletionService(): InlineCompletionService {
  return ServiceRegistry.getInstance().inlineCompletion;
}

export function getMarkdownRenderService(): MarkdownRenderService {
  return ServiceRegistry.getInstance().markdownRender;
}

export function getProjectRuntimeContext(): ProjectRuntimeContext {
  return ServiceRegistry.getInstance().runtime;
}
