/**
 * @file SettingsService.ts - Settings Management Service
 * @description Event-driven application settings management, supports persistence and AI Provider configuration
 * @depends IPC (api.settings), shared/types/defaults
 */

import type { AIConfigDTO, AIProviderDTO, SelectedModels } from '../../../../../shared/ipc/types';
import {
  DEFAULT_COMPILER_AUTO_COMPILE,
  DEFAULT_COMPILER_COMPILE_ON_SAVE,
  DEFAULT_EDITOR_AUTO_COMPLETION,
  DEFAULT_EDITOR_FONT_FAMILY,
  DEFAULT_EDITOR_FONT_SIZE,
  DEFAULT_EDITOR_GHOST_TEXT,
  DEFAULT_EDITOR_LINE_NUMBERS,
  DEFAULT_EDITOR_MINIMAP,
  DEFAULT_EDITOR_TAB_SIZE,
  DEFAULT_EDITOR_WORD_WRAP,
  DEFAULT_LANGUAGE,
  DEFAULT_THEME,
} from '../../../../../shared/types/defaults';
import { DEFAULT_SELECTED_MODELS } from '../../../../../shared/types/provider';
import {
  DisposableStore,
  Emitter,
  type Event,
  type IDisposable,
} from '../../../../../shared/utils';
import { ConfigKeys, api } from '../../api';
import { OPENAI_BASE_URL, OVERLEAF_SERVER_URL } from '../../constants/api';
import { DEFAULT_LATEX_ENGINE } from '../../constants/latex';
import { DELAYS, TIMEOUTS } from '../../constants/timing';
import type { AppSettings } from '../../types';

// ====== Utility ======

/**
 * Derive IM server URL from OT server URL.
 * Rules: port 8082→8081, path /ot→/im.
 */
function deriveIMUrlFromOT(otUrl: string): string | null {
  try {
    const url = new URL(otUrl);
    // Direct mode: http://host:8082 → http://host:8081
    if (url.port === '8082') {
      url.port = '8081';
      return url.toString().replace(/\/+$/, '');
    }
    // Nginx proxy mode: http://host/ot → http://host/im
    if (url.pathname.endsWith('/ot') || url.pathname.endsWith('/ot/')) {
      url.pathname = url.pathname.replace(/\/ot\/?$/, '/im');
      return url.toString().replace(/\/+$/, '');
    }
    // Cannot derive: keep same host and set port to 8081
    url.port = '8081';
    url.pathname = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * Derive TexLive package service URL from OT server URL.
 * Rules: take the origin and append /texlive/ (unified nginx reverse-proxy path).
 * Direct port mode (8082) switches to port 80 via nginx; proxy mode uses same origin + /texlive/.
 */
function deriveTexliveUrlFromOT(otUrl: string): string | null {
  try {
    const url = new URL(otUrl);
    // Direct port mode: http://host:8082 → http://host/texlive/ (nginx on port 80)
    if (url.port === '8082') {
      return `${url.protocol}//${url.hostname}/texlive/`;
    }
    // Nginx proxy mode: http://host/ot → http://host/texlive/
    return `${url.protocol}//${url.host}/texlive/`;
  } catch {
    return null;
  }
}

// ====== Default Settings ======

export const defaultSettings: AppSettings = {
  // NOTE: ai/vlm/whisper config migrated to new Multi-Provider architecture
  // These fields only retain runtime parameters like temperature/maxTokens; API keys are managed by AIProviders
  ai: {
    provider: 'openai',
    apiKey: '',
    baseUrl: OPENAI_BASE_URL,
    model: 'gpt-4o',
    temperature: 0.7,
    maxTokens: 4096,
    timeout: TIMEOUTS.AI,
    completionModel: 'gpt-4o-mini',
    streamResponse: true,
    contextLength: 8000,
  },
  vlm: {
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: '',
    baseUrl: OPENAI_BASE_URL,
    timeout: TIMEOUTS.VLM,
  },
  whisper: {
    provider: 'openai',
    model: 'whisper-1',
    apiKey: '',
    baseUrl: OPENAI_BASE_URL,
    language: 'auto',
    timeout: TIMEOUTS.WHISPER,
  },
  editor: {
    fontSize: DEFAULT_EDITOR_FONT_SIZE,
    fontFamily: DEFAULT_EDITOR_FONT_FAMILY,
    tabSize: DEFAULT_EDITOR_TAB_SIZE,
    wordWrap: DEFAULT_EDITOR_WORD_WRAP,
    minimap: DEFAULT_EDITOR_MINIMAP,
    lineNumbers: DEFAULT_EDITOR_LINE_NUMBERS,
    autoCompletion: DEFAULT_EDITOR_AUTO_COMPLETION,
    ghostText: DEFAULT_EDITOR_GHOST_TEXT,
    cursorStyle: 'line',
    cursorBlinking: 'smooth',
    bracketPairColorization: true,
    highlightActiveLine: true,
    showWhitespace: 'selection',
    formatOnSave: false,
    indentGuides: true,
    renderLineHighlight: 'all',
    smoothScrolling: true,
    stickyScroll: false,
  },
  compiler: {
    engine: DEFAULT_LATEX_ENGINE,
    typstEngine: 'tinymist',
    autoCompile: DEFAULT_COMPILER_AUTO_COMPILE,
    compileOnSave: DEFAULT_COMPILER_COMPILE_ON_SAVE,
    autoCompileDelay: DELAYS.AUTO_COMPILE,
    synctex: true,
    shellEscape: false,
    outputDirectory: './output',
    cleanAuxFiles: true,
    stopOnFirstError: false,
    texliveEndpoint: '',
    overleaf: {
      serverUrl: OVERLEAF_SERVER_URL,
      cookies: '',
      projectId: '',
    },
  },
  ui: {
    theme: DEFAULT_THEME,
    language: DEFAULT_LANGUAGE,
    previewWidth: 400,
    rightPanelWidth: 400,
    sidebarPosition: 'left',
  },
  upload: {
    maxSizePlainText: 10,
    maxSizeRichFormat: 50,
    maxSizeAudio: 25,
    supportedFormats: [
      '.pdf',
      '.txt',
      '.md',
      '.tex',
      '.docx',
      '.jpg',
      '.jpeg',
      '.png',
      '.gif',
      '.webp',
      '.bmp',
      '.mp3',
      '.mp4',
      '.m4a',
      '.wav',
      '.webm',
      '.ogg',
      '.flac',
    ],
    autoChunking: true,
  },
  shortcuts: {
    compile: 'Ctrl+Enter',
    save: 'Ctrl+S',
    commandPalette: 'Ctrl+P',
    chatWithSelection: 'Ctrl+L',
    togglePreview: 'Ctrl+Shift+V',
    newWindow: 'Ctrl+Shift+N',
    inlineEdit: 'Ctrl+K',
  },
  im: {
    serverUrl: '',
    token: '',
  },
  collaboration: {
    enabled: false,
    serverUrl: '',
    token: '',
  },
  assistant: {
    runtime: 'openclaw',
    autoFixCompileErrors: true,
    maxAutoFixRetries: 3,
    openclaw: {
      endpoint: '',
      mode: 'daemon',
      workspaceId: '',
    },
  },
};

// ====== Deep Merge Utility ======

function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result = { ...target } as T;
  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const sourceValue = source[key as keyof T];
      const targetValue = target[key as keyof T];
      if (
        sourceValue !== null &&
        typeof sourceValue === 'object' &&
        !Array.isArray(sourceValue) &&
        targetValue !== null &&
        typeof targetValue === 'object' &&
        !Array.isArray(targetValue)
      ) {
        result[key as keyof T] = deepMerge(
          targetValue as object,
          sourceValue as Partial<typeof targetValue>
        ) as T[keyof T];
      } else if (sourceValue !== undefined) {
        result[key as keyof T] = sourceValue as T[keyof T];
      }
    }
  }
  return result;
}

// ====== SettingsService Implementation ======

export class SettingsService implements IDisposable {
  private readonly _disposables = new DisposableStore();
  private _settings: AppSettings;
  private readonly _storageKey = 'scipen-studio-settings';

  private readonly _onDidChangeSettings = new Emitter<AppSettings>();
  readonly onDidChangeSettings: Event<AppSettings> = this._onDidChangeSettings.event;

  private readonly _onDidChangeAI = new Emitter<AppSettings['ai']>();
  readonly onDidChangeAI: Event<AppSettings['ai']> = this._onDidChangeAI.event;

  private readonly _onDidChangeEditor = new Emitter<AppSettings['editor']>();
  readonly onDidChangeEditor: Event<AppSettings['editor']> = this._onDidChangeEditor.event;

  private readonly _onDidChangeCompiler = new Emitter<AppSettings['compiler']>();
  readonly onDidChangeCompiler: Event<AppSettings['compiler']> = this._onDidChangeCompiler.event;

  private readonly _onDidChangeUI = new Emitter<AppSettings['ui']>();
  readonly onDidChangeUI: Event<AppSettings['ui']> = this._onDidChangeUI.event;

  private readonly _onDidChangeAIProviders = new Emitter<AIConfigDTO>();
  readonly onDidChangeAIProviders: Event<AIConfigDTO> = this._onDidChangeAIProviders.event;

  private _aiProvidersCache: AIProviderDTO[] | null = null;
  private _selectedModelsCache: SelectedModels | null = null;
  private _cleanupAIConfigListener: (() => void) | null = null;
  private _cleanupConfigChangedListener: (() => void) | null = null;

  // Prevents circular updates when syncing from broadcast
  private _isUpdatingFromBroadcast = false;

  constructor() {
    this._settings = this._loadSettings();
    this._disposables.add(this._onDidChangeSettings);
    this._disposables.add(this._onDidChangeAI);
    this._disposables.add(this._onDidChangeEditor);
    this._disposables.add(this._onDidChangeCompiler);
    this._disposables.add(this._onDidChangeUI);
    this._disposables.add(this._onDidChangeAIProviders);

    this._setupAIConfigListener();
    // Listen for main process config changes for multi-window synchronization
    this._setupConfigChangedListener();
  }

  private _setupAIConfigListener(): void {
    if (api.settings?.onAIConfigChanged) {
      this._cleanupAIConfigListener = api.settings.onAIConfigChanged((config) => {
        this._aiProvidersCache = config.providers;
        this._selectedModelsCache = config.selectedModels;
        this._onDidChangeAIProviders.fire(config);
      });
    }
  }

  /**
   * Setup config change listener for multi-window synchronization
   */
  /**
   * Cross-window settings sync: only theme and language propagate (global UI consistency).
   * editor/compiler/im/collaboration/shortcuts are per-window and not broadcast.
   * Extend here by handling additional keys.
   */
  private _setupConfigChangedListener(): void {
    if (api.config?.onChanged) {
      this._cleanupConfigChangedListener = api.config.onChanged((data) => {
        // Prevents circular updates
        if (this._isUpdatingFromBroadcast) return;

        this._isUpdatingFromBroadcast = true;
        try {
          if (data.key === 'theme' && typeof data.value === 'string') {
            const theme = data.value as 'light' | 'dark' | 'system';
            if (this._settings.ui.theme !== theme) {
              this._settings = {
                ...this._settings,
                ui: { ...this._settings.ui, theme },
              };
              this._saveSettings();
              this._onDidChangeUI.fire(this._settings.ui);
              this._onDidChangeSettings.fire(this._settings);
            }
          } else if (data.key === 'language' && typeof data.value === 'string') {
            const language = data.value as 'zh-CN' | 'en-US';
            if (this._settings.ui.language !== language) {
              this._settings = {
                ...this._settings,
                ui: { ...this._settings.ui, language },
              };
              this._saveSettings();
              this._onDidChangeUI.fire(this._settings.ui);
              this._onDidChangeSettings.fire(this._settings);
            }
          }
        } finally {
          this._isUpdatingFromBroadcast = false;
        }
      });
    }
  }

  // ============ Getters ============

  get settings(): AppSettings {
    return this._settings;
  }
  get ai(): AppSettings['ai'] {
    return this._settings.ai;
  }
  get vlm(): AppSettings['vlm'] {
    return this._settings.vlm;
  }
  get whisper(): AppSettings['whisper'] {
    return this._settings.whisper;
  }
  get editor(): AppSettings['editor'] {
    return this._settings.editor;
  }
  get compiler(): AppSettings['compiler'] {
    return this._settings.compiler;
  }
  get ui(): AppSettings['ui'] {
    return this._settings.ui;
  }
  get shortcuts(): AppSettings['shortcuts'] {
    return this._settings.shortcuts;
  }

  // ====== Persistence ======

  private _loadSettings(): AppSettings {
    try {
      const stored = localStorage.getItem(this._storageKey);
      if (stored) {
        const parsed = JSON.parse(stored);

        // Migration: Clean up removed settings fields

        // v1.x: Remove old overleaf.email field
        if (parsed?.compiler?.overleaf && 'email' in parsed.compiler.overleaf) {
          parsed.compiler.overleaf.email = undefined;
        }

        // v2.x: Remove deprecated editor fields
        if (parsed?.editor) {
          parsed.editor.autoSave = undefined;
          parsed.editor.autoSaveDelay = undefined;
        }

        // v2.x: Remove deprecated fields
        parsed.embedding = undefined;
        parsed.rag = undefined;
        parsed.advanced = undefined;

        // v3.x: Strip runtime fields from collaboration (migrated to ProjectRuntimeContext)
        // Also strip legacy provider field (always 'scipen-ot', no longer configurable)
        if (parsed?.collaboration) {
          parsed.collaboration.projectId = undefined;
          parsed.collaboration.fileId = undefined;
          parsed.collaboration.rootPath = undefined;
          parsed.collaboration.botUserId = undefined;
          parsed.collaboration.overleafProjectId = undefined;
          parsed.collaboration.overleafDocMap = undefined;
          parsed.collaboration.overleafServerUrl = undefined;
          parsed.collaboration.provider = undefined;
        }

        // Migration: 'overleaf' engine removed (local-first mode); fall back to xelatex
        if (parsed?.compiler?.engine === 'overleaf') {
          parsed.compiler.engine = 'xelatex';
        }

        const merged = deepMerge(defaultSettings, parsed);
        return merged;
      }
    } catch (e) {
      console.error('[SettingsService] Failed to load settings:', e);
    }
    return { ...defaultSettings };
  }

  private _saveSettings(): void {
    try {
      localStorage.setItem(this._storageKey, JSON.stringify(this._settings));
    } catch (e) {
      console.error('[SettingsService] Failed to save settings:', e);
    }
  }

  // ====== Update Methods ======

  updateSettings(partial: Partial<AppSettings>): void {
    this._settings = deepMerge(this._settings, partial);
    this._saveSettings();
    this._onDidChangeSettings.fire(this._settings);
  }

  // NOTE: updateAI method has been removed
  // AI configuration is now exclusively managed through:
  // 1. AIConfigPanel -> setAIConfig() (persist to ConfigManager)
  // 2. useAIConfigSync hook -> api.ai.updateConfig() (sync to AIService)
  // This eliminates the redundant sync path and prevents configuration conflicts.

  updateEditor(editor: Partial<AppSettings['editor']>): void {
    this._settings = {
      ...this._settings,
      editor: { ...this._settings.editor, ...editor },
    };
    this._saveSettings();
    this._onDidChangeEditor.fire(this._settings.editor);
    this._onDidChangeSettings.fire(this._settings);
  }

  updateCompiler(compiler: Partial<AppSettings['compiler']>): void {
    this._settings = {
      ...this._settings,
      compiler: { ...this._settings.compiler, ...compiler },
    };
    this._saveSettings();
    this._onDidChangeCompiler.fire(this._settings.compiler);
    this._onDidChangeSettings.fire(this._settings);
  }

  updateIM(im: Partial<AppSettings['im']>): void {
    this._settings = {
      ...this._settings,
      im: { ...this._settings.im, ...im },
    };
    this._saveSettings();
    this._onDidChangeSettings.fire(this._settings);
  }

  updateCollaboration(collaboration: Partial<AppSettings['collaboration']>): void {
    // Strip runtime fields — these moved to ProjectRuntimeContext
    const RUNTIME_KEYS = [
      'projectId',
      'fileId',
      'rootPath',
      'botUserId',
      'overleafProjectId',
      'overleafDocMap',
      'overleafServerUrl',
    ] as const;
    const filtered = { ...collaboration };
    for (const key of RUNTIME_KEYS) {
      if (key in filtered) {
        if (process.env.NODE_ENV !== 'production') {
          console.warn(
            `[SettingsService] updateCollaboration: runtime field "${key}" should use ProjectRuntimeContext.update() instead`
          );
        }
        delete filtered[key as keyof typeof filtered];
      }
    }
    if (Object.keys(filtered).length === 0) return;
    this._settings = {
      ...this._settings,
      collaboration: { ...this._settings.collaboration, ...filtered },
    };

    // Auto-sync IM config: OT token doubles as the IM token; derive IM URL automatically.
    // Only overwrite when IM has no standalone config or shares the same token, to avoid clobbering manual setup.
    const merged = this._settings.collaboration;
    if (merged.serverUrl && merged.token) {
      const currentIM = this._settings.im;
      if (!currentIM.serverUrl || currentIM.token === merged.token) {
        const imUrl = deriveIMUrlFromOT(merged.serverUrl);
        if (imUrl) {
          this._settings.im = { serverUrl: imUrl, token: merged.token };
        }
      }

      // Auto-derive TexLive endpoint: take host from OT URL, point at nginx /texlive/.
      // Only applied when the user has not manually configured texliveEndpoint.
      if (!this._settings.compiler.texliveEndpoint) {
        const texliveUrl = deriveTexliveUrlFromOT(merged.serverUrl);
        if (texliveUrl) {
          this._settings.compiler = { ...this._settings.compiler, texliveEndpoint: texliveUrl };
        }
      }
    }

    this._saveSettings();
    this._onDidChangeSettings.fire(this._settings);
  }

  updateUI(ui: Partial<AppSettings['ui']>): void {
    // Prevents re-syncing broadcast-triggered updates back to main process
    if (this._isUpdatingFromBroadcast) return;

    this._settings = {
      ...this._settings,
      ui: { ...this._settings.ui, ...ui },
    };
    this._saveSettings();
    this._onDidChangeUI.fire(this._settings.ui);
    this._onDidChangeSettings.fire(this._settings);

    // Sync theme and language to main process ConfigManager (notify=true triggers broadcast)
    if (ui.theme !== undefined) {
      api.config.set(ConfigKeys.Theme, ui.theme, true).catch((e) => {
        console.error('[SettingsService] Failed to sync theme to ConfigManager:', e);
      });
    }
    if (ui.language !== undefined) {
      api.config.set(ConfigKeys.Language, ui.language, true).catch((e) => {
        console.error('[SettingsService] Failed to sync language to ConfigManager:', e);
      });
    }
  }

  getSettings(): AppSettings {
    return this._settings;
  }

  // ====== AI Providers (Main Process Persistence) ======

  async getAIProviders(): Promise<AIProviderDTO[]> {
    if (this._aiProvidersCache) {
      return this._aiProvidersCache;
    }
    try {
      const providers = await api.settings.getAIProviders();
      this._aiProvidersCache = providers;
      return providers;
    } catch (e) {
      console.error('[SettingsService] Failed to get AI providers:', e);
      return [];
    }
  }

  async setAIProviders(providers: AIProviderDTO[]): Promise<void> {
    try {
      await api.settings.setAIProviders(providers);
      this._aiProvidersCache = providers;
    } catch (e) {
      console.error('[SettingsService] Failed to set AI providers:', e);
    }
  }

  async getSelectedModels(): Promise<SelectedModels> {
    if (this._selectedModelsCache) {
      return this._selectedModelsCache;
    }
    try {
      const models = await api.settings.getSelectedModels();
      this._selectedModelsCache = models;
      return models;
    } catch (e) {
      console.error('[SettingsService] Failed to get selected models:', e);
      return DEFAULT_SELECTED_MODELS;
    }
  }

  async setSelectedModels(models: SelectedModels): Promise<void> {
    try {
      await api.settings.setSelectedModels(models);
      this._selectedModelsCache = models;
    } catch (e) {
      console.error('[SettingsService] Failed to set selected models:', e);
    }
  }

  async getAIConfig(): Promise<AIConfigDTO> {
    try {
      return await api.settings.getAIConfig();
    } catch (e) {
      console.error('[SettingsService] Failed to get AI config:', e);
      return { providers: [], selectedModels: DEFAULT_SELECTED_MODELS };
    }
  }

  async setAIConfig(config: AIConfigDTO): Promise<void> {
    try {
      await api.settings.setAIConfig(config);
      this._aiProvidersCache = config.providers;
      this._selectedModelsCache = config.selectedModels;
    } catch (e) {
      console.error('[SettingsService] Failed to set AI config:', e);
    }
  }

  dispose(): void {
    if (this._cleanupAIConfigListener) {
      this._cleanupAIConfigListener();
      this._cleanupAIConfigListener = null;
    }
    if (this._cleanupConfigChangedListener) {
      this._cleanupConfigChangedListener();
      this._cleanupConfigChangedListener = null;
    }
    this._disposables.dispose();
  }
}

// Module-level getSettingsService removed — obtain it from ServiceRegistry instead.
// Prevents duplicate instances and inconsistent configuration.
