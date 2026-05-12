/**
 * @file index.ts - Core Service Exports
 * @description Unified export of all core services and type definitions
 */

// Services
export { EditorService } from './EditorService';
export type {
  TabChangeEvent,
  ContentChangeEvent,
  DiagnosticsChangeEvent,
  CursorChangeEvent,
  SelectionChangeEvent,
} from './EditorService';

export { ProjectService } from './ProjectService';
export type { FileConflict, ProjectChangeEvent } from './ProjectService';

export { UIService } from './UIService';
export type {
  SidebarTab,
  RightPanelTab,
  CompilationLog,
  PdfHighlight,
  AskAIAboutErrorRequest,
  AgentState,
} from './UIService';

export { SettingsService, defaultSettings } from './SettingsService';
export { ConversationScopeService } from './ConversationScopeService';
export {
  OTService,
  getOTService,
  buildFileTreeFromSnapshot,
  toRelativeProjectPath,
} from './OTService';
export { OverleafLiveService, getOverleafLiveService } from './OverleafLiveService';

export { MarkdownRenderService } from './MarkdownRenderService';

export { ProjectRuntimeContext } from './ProjectRuntimeContext';
export type { ProjectRuntimeState, BootstrapState } from './ProjectRuntimeContext';

// Compile service
export { CompileService, getCompileService } from './CompileService';
export type {
  CompileOptions,
  CompileResult,
  CompileEngine,
  LatexEngine,
  TypstEngine,
} from './CompileService';

// File explorer service
export { getFileExplorerService } from './FileExplorerService';
export type { FileOperationResult, ClipboardItem } from './FileExplorerService';

// Service registry
export {
  ServiceRegistry,
  getServices,
  getEditorService,
  getProjectService,
  getUIService,
  getSettingsService,
  getConversationScopeService,
  getCommandService,
  getKeybindingService,
  getMarkdownRenderService,
  getProjectRuntimeContext,
} from './ServiceRegistry';
export type { IServiceRegistry } from './ServiceRegistry';

// Commands and shortcuts
export { Commands } from '../CommandService';
export type { CommandId } from '../CommandService';
export type { Keybinding } from '../KeybindingService';

// Editor shortcut service
export {
  ShortcutService,
  getShortcutService,
  parseShortcutString,
  parseToMonacoKeybinding,
  isValidShortcut,
  normalizeShortcut,
} from './ShortcutService';
export type { ShortcutAction, ShortcutBinding, ParsedKey } from './ShortcutService';

// Idle task scheduler
export {
  getIdleTaskScheduler,
  scheduleIdleTask,
  cancelIdleTask,
  cancelIdleTasksByPrefix,
  TaskPriority,
} from './IdleTaskScheduler';
export type { IdleTaskOptions } from './IdleTaskScheduler';

// React Hooks
export * from './hooks';
