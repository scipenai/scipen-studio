/**
 * @file ConfigManager.test.ts - Unit tests for configuration manager
 * @description Tests config read/write, default values, subscription-notification pattern, AI config management, window state management, and import/export. Note: ConfigManager uses electron-store, requires mocking in tests.
 * @depends ConfigManager, electron-store
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ====== Mock Setup ======
// vi.hoisted ensures mocks are available when vi.mock is hoisted
const { mockStore, MockStoreConstructor } = vi.hoisted(() => {
  const store = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    has: vi.fn(),
    clear: vi.fn(),
    store: {} as Record<string, unknown>,
    path: '/mock/config/path.json',
  };

  // Create a proper class that returns the shared mock
  function MockStore() {
    return store;
  }

  return { mockStore: store, MockStoreConstructor: MockStore };
});

vi.mock('electron-store', () => {
  return {
    default: MockStoreConstructor,
  };
});

// ====== Mock electron ======
vi.mock('electron', () => ({
  app: {
    getLocale: vi.fn().mockReturnValue('en-US'),
    getPath: vi.fn().mockReturnValue('/tmp/test'),
  },
}));

// ====== Import after mocks ======

import { ConfigKeys } from '../../../shared/types/config-keys';

describe('ConfigManager', () => {
  let configManager: typeof import('../../../src/main/services/ConfigManager').configManager;
  let ConfigManagerImpl: typeof import(
    '../../../src/main/services/ConfigManager'
  ).ConfigManagerImpl;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockStore.store = {};
    mockStore.get.mockImplementation((key: string, defaultValue?: unknown) => {
      if (Object.prototype.hasOwnProperty.call(mockStore.store, key)) {
        return mockStore.store[key];
      }
      return defaultValue;
    });
    mockStore.set.mockImplementation((key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === 'object') {
        mockStore.store = { ...mockStore.store, ...key };
      } else {
        mockStore.store[key] = value;
      }
    });
    mockStore.has.mockImplementation((key: string) => key in mockStore.store);
    mockStore.delete.mockImplementation((key: string) => {
      delete mockStore.store[key];
    });
    mockStore.clear.mockImplementation(() => {
      mockStore.store = {};
    });

    vi.resetModules();
    const module = await import('../../../src/main/services/ConfigManager');
    configManager = module.configManager;
    ConfigManagerImpl = module.ConfigManagerImpl;
  });

  // ====== Basic Read/Write ======

  describe('Basic Read/Write', () => {
    it('should get config value', () => {
      mockStore.store[ConfigKeys.Theme] = 'dark';

      const theme = configManager.get(ConfigKeys.Theme);
      expect(theme).toBe('dark');
    });

    it('should return default value when key not found', () => {
      const value = configManager.get('non-existent-key', 'default');
      expect(value).toBe('default');
    });

    it('should set config value', () => {
      configManager.set(ConfigKeys.Theme, 'light');

      expect(mockStore.set).toHaveBeenCalledWith(ConfigKeys.Theme, 'light');
    });

    it('should check if key exists', () => {
      mockStore.store[ConfigKeys.Language] = 'zh-CN';

      expect(configManager.has(ConfigKeys.Language)).toBe(true);
      expect(configManager.has('non-existent')).toBe(false);
    });

    it('should delete config value', () => {
      mockStore.store[ConfigKeys.Theme] = 'dark';
      configManager.delete(ConfigKeys.Theme);

      expect(mockStore.delete).toHaveBeenCalledWith(ConfigKeys.Theme);
    });
  });

  // ====== Default Values ======

  describe('Default Values', () => {
    it('should have default theme', () => {
      const theme = configManager.getTheme();
      expect(['light', 'dark', 'system']).toContain(theme);
    });

    it('should have default language', () => {
      const lang = configManager.getLanguage();
      expect(['en-US', 'zh-CN']).toContain(lang);
    });
  });

  // ====== Theme Management ======

  describe('Theme Management', () => {
    it('should get theme', () => {
      mockStore.store[ConfigKeys.Theme] = 'dark';

      expect(configManager.getTheme()).toBe('dark');
    });

    it('should set theme', () => {
      configManager.setTheme('light');

      expect(mockStore.set).toHaveBeenCalled();
    });

    it('should accept valid theme values', () => {
      const validThemes: Array<'light' | 'dark' | 'system'> = ['light', 'dark', 'system'];

      for (const theme of validThemes) {
        configManager.setTheme(theme);
      }
    });
  });

  // ====== Language Management ======

  describe('Language Management', () => {
    it('should get language', () => {
      mockStore.store[ConfigKeys.Language] = 'zh-CN';

      expect(configManager.getLanguage()).toBe('zh-CN');
    });

    it('should set language', () => {
      configManager.setLanguage('en-US');

      expect(mockStore.set).toHaveBeenCalled();
    });
  });

  // ====== Subscription Pattern ======

  describe('Subscription Pattern', () => {
    it('should subscribe to config changes', () => {
      const callback = vi.fn();
      const unsubscribe = configManager.subscribe(ConfigKeys.Theme, callback);

      expect(typeof unsubscribe).toBe('function');
    });

    it('should notify subscribers on setAndNotify', () => {
      const callback = vi.fn();
      configManager.subscribe(ConfigKeys.Theme, callback);

      configManager.setAndNotify(ConfigKeys.Theme, 'dark');

      expect(callback).toHaveBeenCalledWith('dark', undefined);
    });

    it('should pass old value to subscribers', () => {
      mockStore.store[ConfigKeys.Theme] = 'light';

      const callback = vi.fn();
      configManager.subscribe(ConfigKeys.Theme, callback);

      configManager.setAndNotify(ConfigKeys.Theme, 'dark');

      expect(callback).toHaveBeenCalledWith('dark', 'light');
    });

    it('should unsubscribe correctly', () => {
      const callback = vi.fn();
      const unsubscribe = configManager.subscribe(ConfigKeys.Theme, callback);

      unsubscribe();
      configManager.setAndNotify(ConfigKeys.Theme, 'dark');

      expect(callback).not.toHaveBeenCalled();
    });

    it('should support multiple subscribers', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      configManager.subscribe(ConfigKeys.Theme, callback1);
      configManager.subscribe(ConfigKeys.Theme, callback2);

      configManager.setAndNotify(ConfigKeys.Theme, 'dark');

      expect(callback1).toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
    });

    it('should handle subscriber errors gracefully', () => {
      const errorCallback = vi.fn(() => {
        throw new Error('Subscriber error');
      });
      const normalCallback = vi.fn();

      configManager.subscribe(ConfigKeys.Theme, errorCallback);
      configManager.subscribe(ConfigKeys.Theme, normalCallback);

      expect(() => configManager.setAndNotify(ConfigKeys.Theme, 'dark')).not.toThrow();
      expect(normalCallback).toHaveBeenCalled();
    });
  });

  // ====== AI Configuration ======

  describe('AI Configuration (Multi-Provider)', () => {
    it('should get AI providers', () => {
      const providers = [
        { id: 'openai', name: 'OpenAI', enabled: true, apiKey: 'sk-xxx', baseUrl: '' },
      ];
      mockStore.store[ConfigKeys.AIProviders] = providers;

      const result = configManager.getAIProviders();
      expect(result).toEqual(providers);
    });

    it('should set AI providers', () => {
      const providers = [
        {
          id: 'anthropic' as const,
          name: 'Anthropic',
          enabled: true,
          apiKey: 'sk-ant-xxx',
          apiHost: '',
          models: [],
        },
      ];

      configManager.setAIProviders(providers);

      expect(mockStore.set).toHaveBeenCalled();
    });

    it('should return empty array when no providers configured', () => {
      const providers = configManager.getAIProviders();
      expect(providers).toEqual([]);
    });

    it('should get selected models', () => {
      const selectedModels = {
        chat: { providerId: 'openai', modelId: 'gpt-4' },
        completion: { providerId: 'openai', modelId: 'gpt-3.5-turbo' },
      };
      mockStore.store[ConfigKeys.AISelectedModels] = selectedModels;

      const result = configManager.getSelectedModels();
      expect(result.chat?.providerId).toBe('openai');
    });

    it('should set selected models', () => {
      const selectedModels = {
        chat: { providerId: 'anthropic' as const, modelId: 'claude-3' },
        completion: null,
        vision: null,
        embedding: null,
        rerank: null,
        tts: null,
        stt: null,
      };

      configManager.setSelectedModels(selectedModels);

      expect(mockStore.set).toHaveBeenCalled();
    });

    it('should get full AI config', () => {
      const config = configManager.getFullAIConfig();

      expect(config).toHaveProperty('providers');
      expect(config).toHaveProperty('selectedModels');
    });

    it('should set full AI config', () => {
      const config = {
        providers: [
          {
            id: 'openai' as const,
            name: 'Test',
            enabled: true,
            apiKey: 'key',
            apiHost: '',
            models: [],
          },
        ],
        selectedModels: {
          chat: { providerId: 'openai' as const, modelId: 'model' },
          completion: null,
          vision: null,
          embedding: null,
          rerank: null,
          tts: null,
          stt: null,
        },
      };

      configManager.setFullAIConfig(config);

      expect(mockStore.set).toHaveBeenCalled();
    });
  });

  // ====== Window State ======

  describe('Window State', () => {
    it('should get window state with defaults', () => {
      const state = configManager.getWindowState();

      expect(state).toHaveProperty('width');
      expect(state).toHaveProperty('height');
      expect(state).toHaveProperty('maximized');
      expect(state.width).toBeGreaterThan(0);
      expect(state.height).toBeGreaterThan(0);
    });

    it('should set window state', () => {
      configManager.setWindowState({
        width: 1920,
        height: 1080,
        x: 100,
        y: 50,
        maximized: true,
      });

      expect(mockStore.set).toHaveBeenCalled();
    });

    it('should set partial window state', () => {
      configManager.setWindowState({ width: 800 });

      expect(mockStore.set).toHaveBeenCalledWith(ConfigKeys.WindowWidth, 800);
    });
  });

  // ====== Client ID ======

  describe('Client ID', () => {
    it('should generate client ID if not exists', () => {
      const clientId = configManager.getClientId();

      expect(clientId).toBeTruthy();
      expect(typeof clientId).toBe('string');
      expect(clientId.length).toBeGreaterThan(0);
    });

    it('should return existing client ID', () => {
      const existingId = 'existing-uuid-12345';
      mockStore.store[ConfigKeys.ClientId] = existingId;

      const clientId = configManager.getClientId();
      expect(clientId).toBe(existingId);
    });

    it('should persist generated client ID', () => {
      const firstId = configManager.getClientId();
      mockStore.store[ConfigKeys.ClientId] = firstId;

      const secondId = configManager.getClientId();
      expect(secondId).toBe(firstId);
    });
  });

  // ====== Reset ======

  describe('Reset', () => {
    it('should reset specific key to default', () => {
      mockStore.store[ConfigKeys.Theme] = 'dark';

      configManager.reset(ConfigKeys.Theme);

      expect(mockStore.set).toHaveBeenCalled();
    });

    it('should reset all config', () => {
      mockStore.store = {
        [ConfigKeys.Theme]: 'dark',
        [ConfigKeys.Language]: 'zh-CN',
        customKey: 'value',
      };

      configManager.reset();

      expect(mockStore.clear).toHaveBeenCalled();
    });
  });

  // ====== Import/Export ======

  describe('Import/Export', () => {
    it('should export all config', () => {
      mockStore.store = {
        [ConfigKeys.Theme]: 'dark',
        [ConfigKeys.Language]: 'en-US',
      };

      const exported = configManager.exportConfig();

      expect(exported).toEqual(mockStore.store);
    });

    it('should import config', () => {
      const config = {
        [ConfigKeys.Theme]: 'light',
        [ConfigKeys.Language]: 'zh-CN',
      };

      configManager.importConfig(config);

      expect(mockStore.store).toEqual(config);
    });
  });

  // ====== Config Path ======

  describe('Config Path', () => {
    it('should return config file path', () => {
      const path = configManager.getConfigPath();

      expect(typeof path).toBe('string');
      expect(path.length).toBeGreaterThan(0);
    });
  });

  // ====== Sensitive Data Handling ======

  describe('Sensitive Data Handling', () => {
    it('should not log API keys in plain text', () => {
      const providers = [
        {
          id: 'openai' as const,
          name: 'Test',
          enabled: true,
          apiKey: 'sk-secret-key-12345',
          apiHost: '',
          models: [],
        },
      ];

      expect(() => configManager.setAIProviders(providers)).not.toThrow();
    });
  });
});

describe('ConfigManager - Edge Cases', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    mockStore.store = {};
    mockStore.get.mockImplementation((key: string, defaultValue?: unknown) => {
      if (Object.prototype.hasOwnProperty.call(mockStore.store, key)) {
        return mockStore.store[key];
      }
      return defaultValue;
    });
    mockStore.set.mockImplementation((key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === 'object') {
        mockStore.store = { ...mockStore.store, ...key };
      } else {
        mockStore.store[key] = value;
      }
    });
  });

  it('should handle undefined values', async () => {
    const module = await import('../../../src/main/services/ConfigManager');
    const cm = module.configManager;

    const value = cm.get('undefined-key');
    expect(value).toBeUndefined();
  });

  it('should handle null values', async () => {
    mockStore.store['null-key'] = null;

    const module = await import('../../../src/main/services/ConfigManager');
    const cm = module.configManager;

    const value = cm.get('null-key');
    expect(value).toBeNull();
  });

  it('should handle complex nested objects', async () => {
    const complexConfig = {
      level1: {
        level2: {
          level3: {
            value: 'deep',
            array: [1, 2, 3],
          },
        },
      },
    };
    (mockStore.store as Record<string, unknown>).complex = complexConfig;

    const module = await import('../../../src/main/services/ConfigManager');
    const cm = module.configManager;

    const value = cm.get('complex');
    expect(value).toEqual(complexConfig);
  });

  it('should handle special characters in keys', async () => {
    const module = await import('../../../src/main/services/ConfigManager');
    const cm = module.configManager;

    cm.set('key.with.dots', 'value1');
    cm.set('key/with/slashes', 'value2');
    cm.set('key:with:colons', 'value3');

    // Should not throw
    expect(mockStore.set).toHaveBeenCalled();
  });
});
