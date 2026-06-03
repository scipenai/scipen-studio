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
  // Tavily API key for the built-in WebSearch tool. Stored here, injected
  // into the sidecar process env as TAVILY_API_KEY at spawn time (the key
  // value never crosses into SnacaConfig). Changing it restarts the sidecar.
  AgentWebSearchApiKey = 'agent.webSearchApiKey',

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

  // ====== Zotero Integration ======
  // 用户是否启用 SciPen 的 Zotero 集成 — 这是唯一的 gate 字段(主开关)。
  // wizard 走完 finish() 设为 true;Settings 页面后续可让用户一键关闭。
  // 与 ZoteroLocalApiEnabled(外部状态镜像)严格区分:前者是 SciPen 内部
  // 启用意图,后者反映 Zotero 客户端那个 "Allow other applications" 勾选。
  // bootstrap / focus refresh / future M2 PDF 嵌入 / future M3 active
  // recommendation 都看这一个主开关。
  ZoteroIntegrationEnabled = 'zotero.integrationEnabled',
  // 已检测到的 Zotero 数据目录(如 C:\Users\me\AppData\Roaming\Zotero\Zotero)。
  // ⚠️ 这是展示字段:仅供 Settings UI 显示给用户看,以及未来 M2 阶段直接
  // 读 storage/{itemKey}/*.pdf 时拼接路径用。**通讯链路完全不读它**
  // (LocalApi / BBT 都打 127.0.0.1:23119,无需 path)。绝不可作为启用 gate
  // — 文件系统状态不是用户意图,gate 用 ZoteroIntegrationEnabled。
  ZoteroPath = 'zotero.path',
  // Whether the user has confirmed the Local API toggle is enabled in
  // Zotero (Settings → Advanced → "Allow other applications…"). Set by
  // wizard after a successful ping; gates @cite + hover behaviour.
  ZoteroLocalApiEnabled = 'zotero.localApiEnabled',
  // Embedding provider selection for M3 active recommendation:
  // 'zhipu' | 'aliyun' | 'openai'.
  ZoteroEmbeddingProvider = 'zotero.embeddingProvider',
  // Master toggle for M3 active citation suggestion panel (default off
  // until A/B internal tests show ≥40% acceptance rate).
  ZoteroActiveRecommendation = 'zotero.activeRecommendation',
  // references.bib 自动同步 —— BibTexSyncService 订阅 main 索引,debounce 写盘。
  ZoteroBibTexSyncEnabled = 'zotero.bibTexSync.enabled',
  ZoteroBibTexSyncFileName = 'zotero.bibTexSync.fileName',
  ZoteroBibTexSyncTranslator = 'zotero.bibTexSync.translator',

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
