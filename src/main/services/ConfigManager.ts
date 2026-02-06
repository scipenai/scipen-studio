/**
 * @file ConfigManager - Configuration manager
 * @description Persistent config management using electron-store with pub/sub notification.
 * @inspired Cherry Studio ConfigManager
 */

import { randomUUID } from 'crypto';
import Store from 'electron-store';
import type { AIConfigDTO, AIProviderDTO, SelectedModels } from '../../../shared/ipc/types';
import { ConfigKeys } from '../../../shared/types/config-keys';
import {
  DEFAULT_COMPILER_AUTO_COMPILE,
  DEFAULT_COMPILER_ENGINE,
  DEFAULT_COMPILER_OUTPUT_FORMAT,
  DEFAULT_EDITOR_FONT_FAMILY,
  DEFAULT_EDITOR_FONT_SIZE,
  DEFAULT_EDITOR_LINE_NUMBERS,
  DEFAULT_EDITOR_TAB_SIZE,
  DEFAULT_EDITOR_WORD_WRAP,
  DEFAULT_LANGUAGE,
  DEFAULT_THEME,
} from '../../../shared/types/defaults';
import { DEFAULT_SELECTED_MODELS } from '../../../shared/types/provider';
import { createLogger } from './LoggerService';
import type { IConfigManager } from './interfaces/IConfigManager';

export { ConfigKeys };

const logger = createLogger('ConfigManager');

/** Get system locale safely (only available in main process) */
function getSystemLocale(): string {
  if (process.type === 'browser') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { app } = require('electron');
      return app.getLocale();
    } catch {
      return 'en-US';
    }
  }
  return process.env.APP_LOCALE || 'en-US';
}

type ConfigSubscriber<T = unknown> = (newValue: T, oldValue?: T) => void;

class ConfigManagerImpl implements IConfigManager {
  private static instance: ConfigManagerImpl;
  private store: Store;
  private subscribers: Map<string, Set<ConfigSubscriber>> = new Map();

  private constructor() {
    this.store = new Store({
      name: 'config',
      defaults: this.getDefaults(),
    });

    logger.info('ConfigManager initialized', {
      configPath: this.store.path,
    });
  }

  /** Get singleton instance */
  public static getInstance(): ConfigManagerImpl {
    if (!ConfigManagerImpl.instance) {
      ConfigManagerImpl.instance = new ConfigManagerImpl();
    }
    return ConfigManagerImpl.instance;
  }

  /** Get default config using shared defaults for consistency */
  private getDefaults(): Record<string, unknown> {
    return {
      [ConfigKeys.Language]: DEFAULT_LANGUAGE,
      [ConfigKeys.Theme]: DEFAULT_THEME,
      // AI configuration defaults are now handled by AIProviders and AISelectedModels
      [ConfigKeys.AIProviders]: [],
      [ConfigKeys.AISelectedModels]: DEFAULT_SELECTED_MODELS,
      [ConfigKeys.EditorFontSize]: DEFAULT_EDITOR_FONT_SIZE,
      [ConfigKeys.EditorFontFamily]: DEFAULT_EDITOR_FONT_FAMILY,
      [ConfigKeys.EditorTabSize]: DEFAULT_EDITOR_TAB_SIZE,
      [ConfigKeys.EditorWordWrap]: DEFAULT_EDITOR_WORD_WRAP,
      [ConfigKeys.EditorLineNumbers]: DEFAULT_EDITOR_LINE_NUMBERS,
      [ConfigKeys.CompilerEngine]: DEFAULT_COMPILER_ENGINE,
      [ConfigKeys.CompilerAutoCompile]: DEFAULT_COMPILER_AUTO_COMPILE,
      [ConfigKeys.CompilerOutputFormat]: DEFAULT_COMPILER_OUTPUT_FORMAT,
      [ConfigKeys.TelemetryEnabled]: false,
      [ConfigKeys.AutoUpdate]: true,
      [ConfigKeys.RecentProjects]: [],
    };
  }

  // ====== Core Read/Write ======

  /** Get config value */
  public get<T>(key: ConfigKeys | string, defaultValue?: T): T {
    return this.store.get(key, defaultValue) as T;
  }

  /** @security Check if key contains sensitive data (API keys, credentials) */
  private isSensitiveKey(key: ConfigKeys | string): boolean {
    const sensitiveKeys = [
      ConfigKeys.AIProviders,
      ConfigKeys.AISelectedModels,
      ConfigKeys.KnowledgeEmbeddingApiKey,
      ConfigKeys.OverleafCookies,
    ];
    return sensitiveKeys.includes(key as ConfigKeys) || key.toLowerCase().includes('apikey');
  }

  /** @security Sanitize sensitive values for logging */
  private sanitizeValueForLog(key: ConfigKeys | string, value: unknown): unknown {
    if (!this.isSensitiveKey(key)) {
      return value;
    }

    if (key === ConfigKeys.AIProviders && Array.isArray(value)) {
      return {
        _sanitized: true,
        count: value.length,
        providers: value.map((p: { id?: string; enabled?: boolean }) => ({
          id: p.id,
          enabled: p.enabled,
        })),
      };
    }

    if (typeof value === 'string') {
      return { _sanitized: true, type: 'string', length: value.length };
    }

    return { _sanitized: true, type: typeof value };
  }

  /** Set config value */
  public set<T>(key: ConfigKeys | string, value: T): void {
    this.store.set(key, value);
    logger.debug(`Config set: ${key}`, { value: this.sanitizeValueForLog(key, value) });
  }

  /** Set config value and notify subscribers */
  public setAndNotify(key: ConfigKeys | string, value: unknown): void {
    const oldValue = this.store.get(key);
    this.store.set(key, value);
    this.notifySubscribers(key, value, oldValue);
    logger.debug(`Config set and notified: ${key}`, {
      value: this.sanitizeValueForLog(key, value),
      oldValue: this.sanitizeValueForLog(key, oldValue),
    });
  }

  /** Delete config key */
  public delete(key: ConfigKeys | string): void {
    this.store.delete(key);
    logger.debug(`Config deleted: ${key}`);
  }

  /** Check if config key exists */
  public has(key: ConfigKeys | string): boolean {
    return this.store.has(key);
  }

  /** Reset to default value */
  public reset(key?: ConfigKeys | string): void {
    if (key) {
      const defaults = this.getDefaults();
      if (key in defaults) {
        this.setAndNotify(key, defaults[key]);
      } else {
        this.delete(key);
      }
    } else {
      this.store.clear();
      this.store.set(this.getDefaults());
      logger.info('All config reset to defaults');
    }
  }

  // ====== Pub/Sub ======

  /** Subscribe to config changes */
  public subscribe<T>(key: ConfigKeys | string, callback: ConfigSubscriber<T>): () => void {
    if (!this.subscribers.has(key)) {
      this.subscribers.set(key, new Set());
    }

    const subscribers = this.subscribers.get(key)!;
    subscribers.add(callback as ConfigSubscriber);

    logger.debug(`Subscribed to config: ${key}`, { subscriberCount: subscribers.size });

    return () => {
      subscribers.delete(callback as ConfigSubscriber);
      if (subscribers.size === 0) {
        this.subscribers.delete(key);
      }
      logger.debug(`Unsubscribed from config: ${key}`);
    };
  }

  /** Notify subscribers */
  private notifySubscribers(key: string, newValue: unknown, oldValue?: unknown): void {
    const subscribers = this.subscribers.get(key);
    if (subscribers && subscribers.size > 0) {
      for (const callback of subscribers) {
        try {
          callback(newValue, oldValue);
        } catch (error) {
          logger.error(`Error in config subscriber for ${key}`, error);
        }
      }
    }
  }

  // ====== Convenience Methods ======

  /** Get language setting */
  public getLanguage(): string {
    const locale = getSystemLocale();
    const defaultLang = ['zh-CN', 'en-US'].includes(locale) ? locale : 'en-US';
    return this.get(ConfigKeys.Language, defaultLang);
  }

  /** Set language */
  public setLanguage(lang: string): void {
    this.setAndNotify(ConfigKeys.Language, lang);
  }

  /** Get theme setting */
  public getTheme(): 'light' | 'dark' | 'system' {
    return this.get(ConfigKeys.Theme, 'system');
  }

  /** Set theme */
  public setTheme(theme: 'light' | 'dark' | 'system'): void {
    this.setAndNotify(ConfigKeys.Theme, theme);
  }

  /** Get client ID (auto-generated on first use for telemetry) */
  public getClientId(): string {
    let clientId = this.get<string>(ConfigKeys.ClientId);

    if (!clientId) {
      clientId = randomUUID();
      this.set(ConfigKeys.ClientId, clientId);
    }

    return clientId;
  }

  // ====== AI Providers (Multi-Provider Architecture) ======

  /** Get AI providers list */
  public getAIProviders(): AIProviderDTO[] {
    return this.get(ConfigKeys.AIProviders, []);
  }

  /** Set AI providers list */
  public setAIProviders(providers: AIProviderDTO[]): void {
    this.setAndNotify(ConfigKeys.AIProviders, providers);
  }

  /** Get selected models config */
  public getSelectedModels(): SelectedModels {
    return this.get(ConfigKeys.AISelectedModels, DEFAULT_SELECTED_MODELS);
  }

  /** Set selected models config */
  public setSelectedModels(models: SelectedModels): void {
    this.setAndNotify(ConfigKeys.AISelectedModels, models);
  }

  /** Get full AI config */
  public getFullAIConfig(): AIConfigDTO {
    return {
      providers: this.getAIProviders(),
      selectedModels: this.getSelectedModels(),
    };
  }

  /** Set full AI config */
  public setFullAIConfig(config: AIConfigDTO): void {
    this.set(ConfigKeys.AIProviders, config.providers);
    this.set(ConfigKeys.AISelectedModels, config.selectedModels);
    this.notifySubscribers(ConfigKeys.AIProviders, config.providers);
    this.notifySubscribers(ConfigKeys.AISelectedModels, config.selectedModels);
  }

  /** Get window state */
  public getWindowState(): {
    width: number;
    height: number;
    x?: number;
    y?: number;
    maximized: boolean;
  } {
    return {
      width: this.get(ConfigKeys.WindowWidth, 1400),
      height: this.get(ConfigKeys.WindowHeight, 900),
      x: this.get(ConfigKeys.WindowX),
      y: this.get(ConfigKeys.WindowY),
      maximized: this.get(ConfigKeys.WindowMaximized, false),
    };
  }

  /** Save window state */
  public setWindowState(state: {
    width?: number;
    height?: number;
    x?: number;
    y?: number;
    maximized?: boolean;
  }): void {
    if (state.width !== undefined) this.set(ConfigKeys.WindowWidth, state.width);
    if (state.height !== undefined) this.set(ConfigKeys.WindowHeight, state.height);
    if (state.x !== undefined) this.set(ConfigKeys.WindowX, state.x);
    if (state.y !== undefined) this.set(ConfigKeys.WindowY, state.y);
    if (state.maximized !== undefined) this.set(ConfigKeys.WindowMaximized, state.maximized);
  }

  /** Get config file path */
  public getConfigPath(): string {
    return this.store.path;
  }

  /** Export all config (for backup) */
  public exportConfig(): Record<string, unknown> {
    return this.store.store;
  }

  /** Import config (for restore) */
  public importConfig(config: Record<string, unknown>): void {
    this.store.store = config;
    logger.info('Config imported');
  }
}

/**
 * @remarks Singleton instance for direct import; shares underlying electron-store.
 */
export const configManager = ConfigManagerImpl.getInstance();

/**
 * @remarks Exported for advanced usage; prefer `createConfigManager` in DI flows.
 */
export { ConfigManagerImpl };

/**
 * @remarks Returns the singleton instance for ServiceContainer registration.
 */
export function createConfigManager(): IConfigManager {
  return ConfigManagerImpl.getInstance();
}
