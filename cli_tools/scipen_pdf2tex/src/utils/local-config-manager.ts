/**
 * @file local-config-manager.ts - Local configuration manager
 * @description Manages VLM configuration in ~/.scipen/config.json shared with SciPen main application
 * @depends fs, path, os, types, logger
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { VLMConfig } from '../types';
import { Logger } from './logger';

export function getScipenHomeDir(): string {
  const scipenHome = path.join(os.homedir(), '.scipen');
  return scipenHome;
}

interface SciPenVLMConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  timeout?: number;
  maxTokens?: number;
  temperature?: number;
}

interface SciPenConfig {
  vlm: SciPenVLMConfig;
}

class LocalConfigManager {
  private configFile = 'config.json';
  private vlmConfig: VLMConfig | null = null;

  private getConfigPath(): string {
    return path.join(getScipenHomeDir(), this.configFile);
  }

  private ensureConfigDir(): void {
    const scipenHome = getScipenHomeDir();
    if (!fs.existsSync(scipenHome)) {
      fs.mkdirSync(scipenHome, { recursive: true });
    }
  }

  load(): VLMConfig | null {
    if (this.vlmConfig) {
      return this.vlmConfig;
    }

    const configPath = this.getConfigPath();
    if (!fs.existsSync(configPath)) {
      Logger.debug(`Config file not found: ${configPath}`);
      return null;
    }

    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      const scipenConfig = JSON.parse(content) as SciPenConfig;

      if (!scipenConfig.vlm) {
        Logger.debug('No vlm config in config file');
        return null;
      }

      // Convert SciPen unified config format to VLMConfig
      this.vlmConfig = {
        baseURL: scipenConfig.vlm.baseUrl,
        apiKey: scipenConfig.vlm.apiKey,
        model: scipenConfig.vlm.model,
        maxTokens: scipenConfig.vlm.maxTokens,
        temperature: scipenConfig.vlm.temperature,
        timeout: scipenConfig.vlm.timeout,
      };

      Logger.debug(`Loaded VLM config: ${configPath}`);
      return this.vlmConfig;
    } catch (error) {
      Logger.warning(`Failed to read config: ${(error as Error).message}`);
      return null;
    }
  }

  getVLMConfig(): VLMConfig | undefined {
    const config = this.load();
    return config || undefined;
  }

  /**
   * Ensure config exists, create default if missing
   * @sideeffect Creates config file and directory if they don't exist
   */
  ensureConfig(): string {
    this.ensureConfigDir();

    const configPath = this.getConfigPath();

    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(content);

        if (!config.vlm) {
          config.vlm = this.getDefaultVLMConfig();
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
          Logger.info('Added default VLM config to existing config file');
        }

        return configPath;
      } catch (error) {
        Logger.warning(`Config file format error, will create new config: ${(error as Error).message}`);
      }
    }

    const defaultConfig = {
      version: '1.0.0',
      vlm: this.getDefaultVLMConfig(),
      metadata: {
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        source: 'default',
      },
    };

    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf-8');
    Logger.success(`Created config file: ${configPath}`);

    return configPath;
  }

  private getDefaultVLMConfig(): SciPenVLMConfig {
    return {
      provider: 'openai',
      model: 'gpt-4-vision-preview',
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      timeout: 120000,
      maxTokens: 8000,
      temperature: 0.3,
    };
  }

  exists(): boolean {
    const configPath = this.getConfigPath();
    if (!fs.existsSync(configPath)) {
      return false;
    }

    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(content);
      return !!config.vlm;
    } catch {
      return false;
    }
  }

  reload(): VLMConfig | null {
    this.vlmConfig = null;
    return this.load();
  }
}

export const localConfigManager = new LocalConfigManager();
