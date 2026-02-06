/**
 * @file IConfigManager - Configuration manager contract
 * @description Public interface for config access used in dependency injection
 * @depends ConfigManagerImpl
 */

import type { AIConfigDTO, AIProviderDTO, SelectedModels } from '@shared/ipc/types';
import type { ConfigKeys } from '@shared/types/config-keys';

/**
 * Configuration manager interface.
 * Exposes only the capabilities required by dependent services.
 */
export interface IConfigManager {
  // ====== Generic Config Access ======

  /**
   * Reads a configuration value.
   * @param key Config key
   * @param defaultValue Value to return when key is missing
   * @returns Stored value or defaultValue
   */
  get<T>(key: ConfigKeys | string, defaultValue?: T): T;

  /**
   * Writes a configuration value.
   * @param key Config key
   * @param value New value
   * @sideeffect Persists value and may notify subscribers
   */
  set<T>(key: ConfigKeys | string, value: T): void;

  // ====== AI Configuration ======

  /**
   * Returns configured AI providers.
   */
  getAIProviders(): AIProviderDTO[];

  /**
   * Returns selected model configuration.
   */
  getSelectedModels(): SelectedModels;

  /**
   * Returns full AI configuration (providers + selected models).
   */
  getFullAIConfig(): AIConfigDTO;

  /**
   * Writes full AI configuration.
   * @param config AI config payload
   * @sideeffect Persists provider and model selection
   */
  setFullAIConfig(config: AIConfigDTO): void;

  // ====== Subscriptions ======

  /**
   * Subscribes to config changes for a key.
   * @param key Config key
   * @param callback Called with new and old values
   * @returns Unsubscribe function
   */
  subscribe<T>(key: ConfigKeys | string, callback: (newValue: T, oldValue?: T) => void): () => void;
}
