/**
 * @file ServiceRegistry.ts - Service Registry
 * @description Unified management of service registration, retrieval and lifecycle
 * @depends EditorService, ProjectService, SettingsService, AIService, CompileService
 */

import { DisposableStore, type IDisposable } from '../../../../../shared/utils';
import { CommandServiceImpl, _setCommandServiceInstance } from '../CommandService';
import {
  InlineCompletionService,
  _setInlineCompletionServiceInstance,
} from '../InlineCompletionService';
import { KeybindingServiceImpl, _setKeybindingServiceInstance } from '../KeybindingService';
import { StorageService, _setStorageServiceInstance } from '../StorageService';
import { AIService } from './AIService';
import { BackupService, _setBackupServiceInstance } from './BackupService';
import { CompileService, _setCompileServiceInstance } from './CompileService';
import { EditorService } from './EditorService';
import { ProjectService } from './ProjectService';
import { SettingsService } from './SettingsService';
import { UIService } from './UIService';
import { registerBuiltinViews } from './ViewContribution';
import { ViewRegistry, _setViewRegistryInstance } from './ViewRegistry';
import { WorkingCopyService, _setWorkingCopyServiceInstance } from './WorkingCopyService';

// ====== Service Interface ======

export interface IServiceRegistry extends IDisposable {
  readonly storage: StorageService;
  readonly editor: EditorService;
  readonly ai: AIService;
  readonly project: ProjectService;
  readonly ui: UIService;
  readonly settings: SettingsService;
  readonly workingCopy: WorkingCopyService;
  readonly backup: BackupService;
  readonly compile: CompileService;
  readonly command: CommandServiceImpl;
  readonly keybinding: KeybindingServiceImpl;
  readonly view: ViewRegistry;
  readonly inlineCompletion: InlineCompletionService;
}

// ====== Singleton Instance ======

let Instance: ServiceRegistry | null = null;

// ====== ServiceRegistry Implementation ======

export class ServiceRegistry implements IServiceRegistry {
  private readonly _disposables = new DisposableStore();

  readonly storage: StorageService;
  readonly editor: EditorService;
  readonly ai: AIService;
  readonly project: ProjectService;
  readonly ui: UIService;
  readonly settings: SettingsService;
  readonly workingCopy: WorkingCopyService;
  readonly backup: BackupService;
  readonly compile: CompileService;
  readonly command: CommandServiceImpl;
  readonly keybinding: KeybindingServiceImpl;
  readonly view: ViewRegistry;
  readonly inlineCompletion: InlineCompletionService;

  private constructor() {
    // StorageService must be created first as other services depend on it
    this.storage = new StorageService();
    _setStorageServiceInstance(this.storage);

    this.editor = new EditorService();
    this.ai = new AIService();
    this.project = new ProjectService();
    this.ui = new UIService();
    this.settings = new SettingsService();

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

    this.view = new ViewRegistry();
    _setViewRegistryInstance(this.view);
    this._disposables.add(registerBuiltinViews(this.view));

    this.inlineCompletion = new InlineCompletionService();
    _setInlineCompletionServiceInstance(this.inlineCompletion);

    // Register all services to disposables for unified lifecycle management
    this._disposables.add(this.storage);
    this._disposables.add(this.editor);
    this._disposables.add(this.ai);
    this._disposables.add(this.project);
    this._disposables.add(this.ui);
    this._disposables.add(this.settings);
    this._disposables.add(this.workingCopy);
    this._disposables.add(this.backup);
    this._disposables.add(this.compile);
    this._disposables.add(this.command);
    this._disposables.add(this.keybinding);
    this._disposables.add(this.view);
    this._disposables.add(this.inlineCompletion);
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

export function getAIService(): AIService {
  return ServiceRegistry.getInstance().ai;
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

export function getViewRegistry(): ViewRegistry {
  return ServiceRegistry.getInstance().view;
}

export function getInlineCompletionService(): InlineCompletionService {
  return ServiceRegistry.getInstance().inlineCompletion;
}
