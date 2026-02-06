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

export { AIService } from './AIService';
export type {
  SessionEntity,
  SessionChangeEvent,
  MessageChangeEvent,
  PolishRequest,
} from './AIService';

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
export { getFileExplorerService, useFileExplorerService } from './FileExplorerService';
export type { FileOperationResult, ClipboardItem } from './FileExplorerService';

// Knowledge base service
export { getKnowledgeBaseService, useKnowledgeBaseService } from './KnowledgeBaseService';
export type { DocumentInfo, UploadTask, OperationResult } from './KnowledgeBaseService';

// Agent tools service
export { getAgentToolsService, useAgentToolsService } from './AgentToolsService';

// Service registry
export {
  ServiceRegistry,
  getServices,
  getEditorService,
  getAIService,
  getProjectService,
  getUIService,
  getSettingsService,
  getCommandService,
  getKeybindingService,
  getViewRegistry,
} from './ServiceRegistry';
export type { IServiceRegistry } from './ServiceRegistry';

// View registry
export { ViewRegistry, ViewLocation } from './ViewRegistry';
export type {
  ViewDescriptor,
  ViewRegistrationEvent,
  ViewDeregistrationEvent,
} from './ViewRegistry';
export { BuiltinViews, registerBuiltinViews } from './ViewContribution';
export type { BuiltinViewId } from './ViewContribution';

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
