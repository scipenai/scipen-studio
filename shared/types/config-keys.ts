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

  // ====== Agent (SNACA runtime) Configuration ======
  // Approval gate behaviour for file-mutation / shell tools.
  // 'interactive' | 'auto_allow' | 'auto_deny'.
  AgentApprovalMode = 'agent.approvalMode',
  // Engine tunables — partial `SnacaConfig.engine` overrides stored as
  // a single JSON object. Unset fields fall back to model-aware defaults.
  AgentEngineConfig = 'agent.engineConfig',
  // MCP server definitions — array of `{ name, transport, command?,
  // args?, env?, url?, init_timeout_secs? }`. Wire-shape; passed
  // straight to `SnacaConfig.mcp_servers`.
  AgentMcpServers = 'agent.mcpServers',

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

  // ====== Miscellaneous ======
  RecentProjects = 'recentProjects',
  LastOpenedProject = 'lastOpenedProject',
  TelemetryEnabled = 'telemetry.enabled',
  AutoUpdate = 'autoUpdate',
  ClientId = 'clientId',
}

export type ConfigKey = `${ConfigKeys}`;
