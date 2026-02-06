/**
 * @file Configuration Keys
 * @description Unified configuration key management to prevent typos
 * @depends None (pure enum definitions)
 */

export enum ConfigKeys {
  // ====== App Settings ======
  Language = 'language',
  Theme = 'theme',

  // ====== AI Configuration ======
  AIProviders = 'ai.providers',
  AISelectedModels = 'ai.selectedModels',

  // ====== Knowledge Base Configuration ======
  KnowledgeStoragePath = 'knowledge.storagePath',
  KnowledgeEmbeddingModel = 'knowledge.embeddingModel',
  KnowledgeEmbeddingApiKey = 'knowledge.embeddingApiKey',
  KnowledgeEmbeddingBaseUrl = 'knowledge.embeddingBaseUrl',

  // ====== Editor Configuration ======
  EditorFontSize = 'editor.fontSize',
  EditorFontFamily = 'editor.fontFamily',
  EditorTabSize = 'editor.tabSize',
  EditorWordWrap = 'editor.wordWrap',
  EditorLineNumbers = 'editor.lineNumbers',

  // ====== Compiler Configuration ======
  CompilerEngine = 'compiler.engine',
  CompilerAutoCompile = 'compiler.autoCompile',
  CompilerOutputFormat = 'compiler.outputFormat',

  // ====== Overleaf Configuration ======
  OverleafServerUrl = 'overleaf.serverUrl',
  OverleafCookies = 'overleaf.cookies',

  // ====== Window Configuration ======
  WindowWidth = 'window.width',
  WindowHeight = 'window.height',
  WindowX = 'window.x',
  WindowY = 'window.y',
  WindowMaximized = 'window.maximized',

  // ====== Selection Assistant Configuration ======
  SelectionEnabled = 'selection.enabled',
  SelectionTriggerMode = 'selection.triggerMode',
  SelectionShortcutKey = 'selection.shortcutKey',
  SelectionDefaultLibraryId = 'selection.defaultLibraryId',

  // ====== Miscellaneous ======
  RecentProjects = 'recentProjects',
  LastOpenedProject = 'lastOpenedProject',
  TelemetryEnabled = 'telemetry.enabled',
  AutoUpdate = 'autoUpdate',
  ClientId = 'clientId',
}

export type ConfigKey = `${ConfigKeys}`;
