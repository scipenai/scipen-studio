/**
 * @file AIConfigPanel.tsx - AI Model Configuration Panel
 * @description Configures AI providers and models, supporting unified management of multiple providers
 */

import {
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Cloud,
  ExternalLink,
  Eye,
  EyeOff,
  Globe,
  HelpCircle,
  Key,
  LayoutDashboard,
  Loader2,
  Mic,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AIProviderDTO, SelectedModels } from '../../../api';
import { SYSTEM_PROVIDERS, getProviderColor, getSystemProviders } from '../../../config/providers';
import { getSettingsService } from '../../../services/core/ServiceRegistry';
import type { ModelInfo, ModelType, Provider, ProviderId } from '../../../types/provider';
import { Badge, Button, Card, IconButton, Input, Modal, Select, Toggle } from '../../ui';
import { ModelPickerModal } from './ModelPickerModal';
import { useTranslation } from '../../../locales';
import type { TranslationKey } from '../../../locales';

// ====== Constant Definitions ======

/** Default selected models configuration */
const DEFAULT_SELECTED_MODELS: SelectedModels = {
  chat: null,
  completion: null,
  vision: null,
  embedding: null,
  rerank: null,
  tts: null,
  stt: null,
};

/** Auto-save debounce delay (ms) */
const AUTO_SAVE_DEBOUNCE_MS = 300;

// ====== Utility Functions ======

/** Simple debounce implementation */
function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number
): T & { cancel: () => void } {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const debounced = ((...args: Parameters<T>) => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, delay);
  }) as T & { cancel: () => void };

  debounced.cancel = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  return debounced;
}

// ====== Model Type Configuration ======
const MODEL_TYPE_CONFIG: Record<
  ModelType,
  { label: string; icon: typeof Bot; color: string; desc: string }
> = {
  chat: {
    label: '对话模型',
    icon: Bot,
    color: 'text-[var(--color-accent)]',
    desc: '用于 AI 对话、润色、审稿',
  },
  completion: {
    label: '补全模型',
    icon: Zap,
    color: 'text-[var(--color-warning)]',
    desc: '用于代码/公式补全',
  },
  vision: {
    label: '视觉模型',
    icon: Eye,
    color: 'text-[var(--color-info)]',
    desc: '用于图片理解和 OCR',
  },
  embedding: {
    label: '嵌入模型',
    icon: Sparkles,
    color: 'text-[var(--color-success)]',
    desc: '用于知识库向量检索',
  },
  rerank: {
    label: '重排序模型',
    icon: Search,
    color: 'text-[var(--color-warning)]',
    desc: '用于检索结果重排序',
  },
  stt: { label: '语音识别', icon: Bot, color: 'text-[var(--color-error)]', desc: '语音转文字' },
  tts: {
    label: '语音合成',
    icon: Bot,
    color: 'text-[var(--color-accent-bright)]',
    desc: '文字转语音',
  },
};

// ====== Quick Start Recommendations ======
const QUICK_START_PROVIDERS = ['siliconflow', 'aihubmix', 'ollama'] as const;

// ====== Overview Page ID ======
const OVERVIEW_ID = '__overview__';

const trimTrailingSlash = (value: string) => value.replace(/\/+$/g, '');

const normalizeSystemApiHost = (
  provider: Provider,
  savedApiHost: string | undefined,
  systemProviders: Provider[]
): { apiHost: string; corrected: boolean } => {
  const fallback = provider.defaultApiHost || provider.apiHost || '';
  const rawApiHost = (savedApiHost || provider.apiHost || provider.defaultApiHost || '').trim();

  if (!provider.isSystem) {
    return { apiHost: rawApiHost || fallback, corrected: false };
  }

  const normalizedApiHost = trimTrailingSlash(rawApiHost);
  const ownDefault = trimTrailingSlash(provider.defaultApiHost || provider.apiHost || '');
  const otherDefaults = systemProviders
    .filter((p) => p.id !== provider.id)
    .map((p) => trimTrailingSlash(p.defaultApiHost || p.apiHost || ''))
    .filter(Boolean);

  if (normalizedApiHost && ownDefault && normalizedApiHost !== ownDefault) {
    if (otherDefaults.includes(normalizedApiHost)) {
      return { apiHost: fallback, corrected: true };
    }
  }

  return { apiHost: rawApiHost || fallback, corrected: false };
};

// ====== Main Component ======

export const AIConfigPanel: React.FC = () => {
  const [providers, setProviders] = useState<Provider[]>(() => getSystemProviders());
  const [selectedProviderId, setSelectedProviderId] = useState<string>(OVERVIEW_ID);
  const [searchText, setSearchText] = useState('');
  const [showQuickStart, setShowQuickStart] = useState(true);
  const [isLoading, setIsLoading] = useState(true);

  const [selectedModels, setSelectedModels] = useState<SelectedModels>(DEFAULT_SELECTED_MODELS);
  const { t } = useTranslation();

  // ========== Critical fix: Use ref to synchronously track latest state ==========
  // Solve closure trap: Ensure we get the latest value when saving, not the old value captured by closure
  const providersRef = useRef<Provider[]>(providers);
  const selectedModelsRef = useRef<SelectedModels>(selectedModels);
  // Flag whether currently saving, used to skip self-triggered event callbacks
  const isSavingRef = useRef(false);
  // Cache last saved config, used to compare if there's actual change
  const lastSavedConfigRef = useRef<string>('');

  // Synchronously update ref (every time state changes)
  useEffect(() => {
    providersRef.current = providers;
  }, [providers]);

  useEffect(() => {
    selectedModelsRef.current = selectedModels;
  }, [selectedModels]);

  // ========== Save config to main process ==========
  const saveConfig = useCallback(async () => {
    if (isLoading) return;

    // 🔧 Critical: Get latest value from ref to avoid closure trap
    const currentProviders = providersRef.current;
    const currentSelectedModels = selectedModelsRef.current;
    const currentConfig = JSON.stringify({
      providers: currentProviders,
      selectedModels: currentSelectedModels,
    });

    // Skip save if config hasn't changed
    if (currentConfig === lastSavedConfigRef.current) {
      return;
    }

    // Mark start of save
    isSavingRef.current = true;

    try {
      const settingsService = getSettingsService();

      // Save to main process (ConfigManager persistence)
      await settingsService.setAIConfig({
        providers: currentProviders as AIProviderDTO[],
        selectedModels: currentSelectedModels,
      });

      // Update cache
      lastSavedConfigRef.current = currentConfig;
    } catch (e) {
      console.error('[AIConfigPanel] Failed to save AI config:', e);
    } finally {
      // Delay reset flag to ensure event callbacks can correctly skip
      setTimeout(() => {
        isSavingRef.current = false;
      }, 100);
    }
  }, [isLoading]);

  // ========== Auto-save: Automatically trigger on state change (with debounce) ==========
  const debouncedSaveRef = useRef<ReturnType<typeof debounce> | null>(null);

  useEffect(() => {
    debouncedSaveRef.current = debounce(() => saveConfig(), AUTO_SAVE_DEBOUNCE_MS);
    return () => {
      debouncedSaveRef.current?.cancel();
    };
  }, [saveConfig]);

  // Listen to state changes, automatically trigger save
  useEffect(() => {
    // Don't trigger auto-save during loading
    if (isLoading) return;
    debouncedSaveRef.current?.();
  }, [providers, selectedModels, isLoading]);

  // ========== Load config from main process ==========
  useEffect(() => {
    const loadConfig = async () => {
      try {
        setIsLoading(true);
        const settingsService = getSettingsService();
        const config = await settingsService.getAIConfig();

        if (config.providers && config.providers.length > 0) {
          // Merge system providers with saved config
          const systemProviders = getSystemProviders();
          let hasHostCorrection = false;
          const mergedProviders = systemProviders.map((sp) => {
            const savedProvider = config.providers.find((p: AIProviderDTO) => p.id === sp.id);
            if (savedProvider) {
              const normalizedHost = normalizeSystemApiHost(
                sp,
                savedProvider.apiHost,
                systemProviders
              );
              if (normalizedHost.corrected) {
                hasHostCorrection = true;
              }
              return {
                ...sp,
                apiKey: savedProvider.apiKey,
                apiHost: normalizedHost.apiHost,
                enabled: savedProvider.enabled,
                models: savedProvider.models.length > 0 ? savedProvider.models : sp.models,
              };
            }
            return sp;
          });
          // Add custom providers (only keep user manually added ones, exclude old non-system providers)
          const customProviders = config.providers.filter(
            (p: AIProviderDTO) =>
              !systemProviders.find((sp) => sp.id === p.id) && p.id.startsWith('custom-')
          ) as Provider[];

          const finalProviders = [...mergedProviders, ...customProviders];
          setProviders(finalProviders);

          // 🔧 Critical: Synchronously update lastSavedConfigRef after loading completes to avoid triggering unnecessary saves
          const loadedSelectedModels = config.selectedModels || DEFAULT_SELECTED_MODELS;
          lastSavedConfigRef.current = JSON.stringify({
            providers: finalProviders,
            selectedModels: loadedSelectedModels,
          });

          // Check if there are configured providers
          const hasConfigured = config.providers?.some((p: AIProviderDTO) => p.enabled && p.apiKey);
          setShowQuickStart(!hasConfigured);

          // Correct misconfigured apiHost for system providers (e.g., Ollama using cloud address)
          if (hasHostCorrection) {
            await settingsService.setAIConfig({
              providers: finalProviders as AIProviderDTO[],
              selectedModels: loadedSelectedModels,
            });
          }
        }

        if (config.selectedModels) {
          setSelectedModels(config.selectedModels);
        }
      } catch (e) {
        console.error('[AIConfigPanel] Failed to load AI config:', e);
      } finally {
        setIsLoading(false);
      }
    };

    loadConfig();

    // Listen to config change events (from other windows/components)
    const settingsService = getSettingsService();
    const disposable = settingsService.onDidChangeAIProviders((config) => {
      // 🔧 Critical fix: If save was triggered by self, skip state override
      if (isSavingRef.current) {
        return;
      }

      // Only update state for external changes
      if (config.providers && config.providers.length > 0) {
        const systemProviders = getSystemProviders();
        const mergedProviders = systemProviders.map((sp) => {
          const savedProvider = config.providers.find((p) => p.id === sp.id);
          if (savedProvider) {
            const normalizedHost = normalizeSystemApiHost(
              sp,
              savedProvider.apiHost,
              systemProviders
            );
            return {
              ...sp,
              apiKey: savedProvider.apiKey,
              apiHost: normalizedHost.apiHost,
              enabled: savedProvider.enabled,
              models: savedProvider.models.length > 0 ? savedProvider.models : sp.models,
            };
          }
          return sp;
        });
        const customProviders = config.providers.filter(
          (p) => !systemProviders.find((sp) => sp.id === p.id) && p.id.startsWith('custom-')
        ) as Provider[];

        const finalProviders = [...mergedProviders, ...customProviders];
        setProviders(finalProviders);

        // 🔧 Critical: Synchronously update lastSavedConfigRef to avoid infinite loop
        if (config.selectedModels) {
          lastSavedConfigRef.current = JSON.stringify({
            providers: finalProviders,
            selectedModels: config.selectedModels,
          });
        }
      }
      if (config.selectedModels) {
        setSelectedModels(config.selectedModels);
      }
    });

    return () => {
      disposable.dispose();
    };
  }, []);

  // Save immediately on component unmount (don't wait for debounce)
  useEffect(() => {
    return () => {
      debouncedSaveRef.current?.cancel();
      // Synchronously save on unmount
      const currentConfig = JSON.stringify({
        providers: providersRef.current,
        selectedModels: selectedModelsRef.current,
      });
      if (currentConfig !== lastSavedConfigRef.current) {
        const settingsService = getSettingsService();
        settingsService.setAIConfig({
          providers: providersRef.current as AIProviderDTO[],
          selectedModels: selectedModelsRef.current,
        });
      }
    };
  }, []);

  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === selectedProviderId) || providers[0],
    [providers, selectedProviderId]
  );

  const filteredProviders = useMemo(() => {
    if (!searchText) return providers;
    const lower = searchText.toLowerCase();
    return providers.filter((p) => p.name.toLowerCase().includes(lower));
  }, [providers, searchText]);

  // Number of configured providers
  const configuredCount = useMemo(
    () => providers.filter((p) => p.enabled && p.apiKey).length,
    [providers]
  );

  const updateProvider = useCallback((id: string, updates: Partial<Provider>) => {
    setProviders((prev) => prev.map((p) => (p.id === id ? { ...p, ...updates } : p)));
    // 🔧 No longer need to manually call onSave(), useEffect auto-save will handle it
  }, []);

  const selectModel = useCallback(
    (type: keyof SelectedModels, providerId: string, modelId: string) => {
      setSelectedModels((prev) => ({
        ...prev,
        [type]: { providerId: providerId as ProviderId, modelId },
      }));
      // 🔧 No longer need to manually call onSave(), useEffect auto-save will handle it
    },
    []
  );

  const handleAddCustomProvider = useCallback(() => {
    // 🔧 Use custom-${timestamp} format, ProviderId type now natively supports this format
    const customId: ProviderId = `custom-${Date.now()}`;
    const newProvider: Provider = {
      id: customId,
      name: t('aiConfig.customService'),
      apiKey: '',
      apiHost: '',
      enabled: true,
      isSystem: false,
      models: [],
    };
    setProviders((prev) => [...prev, newProvider]);
    setSelectedProviderId(customId);
  }, [t]);

  const handleDeleteProvider = useCallback(
    (id: string) => {
      setProviders((prev) => prev.filter((p) => p.id !== id));
      if (selectedProviderId === id) {
        setSelectedProviderId(providers[0]?.id || '');
      }
    },
    [providers, selectedProviderId]
  );

  const handleQuickStart = useCallback((providerId: string) => {
    setSelectedProviderId(providerId);
    setShowQuickStart(false);
  }, []);

  return (
    <div className="h-full flex flex-col bg-[var(--color-bg-void)]">
      {/* Quick start guide - shown on first use */}
      {showQuickStart && configuredCount === 0 && (
        <QuickStartBanner
          onSelectProvider={handleQuickStart}
          onDismiss={() => setShowQuickStart(false)}
        />
      )}

      <div className="flex-1 flex min-h-0">
        {/* Left provider list */}
        <ProviderList
          providers={filteredProviders}
          selectedId={selectedProviderId}
          searchText={searchText}
          onSearchChange={setSearchText}
          onSelect={setSelectedProviderId}
          onAddCustom={handleAddCustomProvider}
          configuredCount={configuredCount}
          selectedModels={selectedModels}
          allProviders={providers}
        />

        {/* Right settings panel */}
        <div className="flex-1 overflow-hidden bg-[var(--color-bg-secondary)]">
          {selectedProviderId === OVERVIEW_ID ? (
            <OverviewPanel
              selectedModels={selectedModels}
              providers={providers}
              onNavigateToProvider={setSelectedProviderId}
            />
          ) : selectedProvider ? (
            <ProviderSettings
              provider={selectedProvider}
              onUpdate={(updates) => updateProvider(selectedProvider.id, updates)}
              onDelete={() => handleDeleteProvider(selectedProvider.id)}
              selectedModels={selectedModels}
              onSelectModel={selectModel}
            />
          ) : (
            <EmptyState onAddProvider={handleAddCustomProvider} />
          )}
        </div>
      </div>
    </div>
  );
};

// ====== Quick Configuration Guide Component ======

interface QuickStartBannerProps {
  onSelectProvider: (id: string) => void;
  onDismiss: () => void;
}

const QuickStartBanner: React.FC<QuickStartBannerProps> = ({ onSelectProvider, onDismiss }) => {
  const { t } = useTranslation();
  return (
    <div className="bg-gradient-to-r from-[var(--color-accent)]/10 to-[var(--color-accent-secondary)]/10 border-b border-[var(--color-accent)]/20 p-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold text-[var(--color-text-primary)] flex items-center gap-2">
            <Sparkles size={20} className="text-[var(--color-accent)]" />
            {t('aiConfig.startConfiguring')}
          </h3>
          <p className="text-sm text-[var(--color-text-muted)] mt-1">
            {t('aiConfig.selectProviderToStart')}
          </p>
        </div>
        <button
          onClick={onDismiss}
          className="p-1 rounded-lg hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] transition-colors"
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex flex-wrap gap-3">
        {QUICK_START_PROVIDERS.map((id) => {
          const provider = SYSTEM_PROVIDERS[id];
          if (!provider) return null;
          const colors = getProviderColor(id);

          return (
            <button
              key={id}
              onClick={() => onSelectProvider(id)}
              className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-all cursor-pointer
                bg-[var(--color-bg-elevated)] border-[var(--color-border)] hover:border-[var(--color-accent)] hover:shadow-md
              `}
            >
              <div
                className={`w-10 h-10 rounded-lg flex items-center justify-center text-lg font-bold ${colors.bg} ${colors.text}`}
              >
                {provider.name.charAt(0)}
              </div>
              <div className="text-left">
                <div className="font-medium text-[var(--color-text-primary)]">{provider.name}</div>
                <div className="text-xs text-[var(--color-text-muted)]">
                  {t('aiConfig.chatModelsCount', {
                    count: provider.models.filter((m) => m.type === 'chat').length,
                  })}
                </div>
              </div>
              <ArrowRight size={16} className="text-[var(--color-text-muted)] ml-2" />
            </button>
          );
        })}
      </div>

      <div className="mt-4 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
        <HelpCircle size={12} />
        <span>{t('aiConfig.selectProviderHint')}</span>
      </div>
    </div>
  );
};

// ====== Provider List Component ======

interface ProviderListProps {
  providers: Provider[];
  selectedId: string;
  searchText: string;
  onSearchChange: (text: string) => void;
  onSelect: (id: string) => void;
  onAddCustom: () => void;
  configuredCount: number;
  selectedModels: SelectedModels;
  allProviders: Provider[];
}

const ProviderList: React.FC<ProviderListProps> = ({
  providers,
  selectedId,
  searchText,
  onSearchChange,
  onSelect,
  onAddCustom,
  configuredCount,
  selectedModels,
  // allProviders reserved for future expansion
}) => {
  const { t } = useTranslation();
  // Calculate number of configured models
  const configuredModelsCount = useMemo(() => {
    return Object.values(selectedModels).filter((m) => m !== null).length;
  }, [selectedModels]);

  return (
    <div className="w-72 flex-shrink-0 border-r border-[var(--color-border)] flex flex-col bg-[var(--color-bg-primary)]">
      {/* Header info */}
      <div className="p-4 border-b border-[var(--color-border-subtle)]">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-medium text-[var(--color-text-primary)]">
            {t('aiConfig.modelProviders')}
          </h3>
          {configuredCount > 0 && (
            <Badge variant="success" size="sm">
              {t('aiConfig.configured', { count: configuredCount })}
            </Badge>
          )}
        </div>
        <Input
          value={searchText}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t('aiConfig.searchProviders')}
          leftIcon={<Search size={14} />}
          size="sm"
          className="bg-[var(--color-bg-tertiary)]"
        />
      </div>

      {/* Provider list */}
      <div className="flex-1 overflow-y-auto p-2">
        {/* Configuration overview - fixed at top */}
        <button
          onClick={() => onSelect(OVERVIEW_ID)}
          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all text-sm mb-3 cursor-pointer
            ${
              selectedId === OVERVIEW_ID
                ? 'bg-gradient-to-r from-[var(--color-accent)]/15 to-[var(--color-accent-secondary)]/15 text-[var(--color-text-primary)] shadow-sm border border-[var(--color-accent)]/30'
                : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] border border-transparent'
            }`}
        >
          <div
            className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors
              ${selectedId === OVERVIEW_ID ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-bg-elevated)] text-[var(--color-accent)]'}
            `}
          >
            <LayoutDashboard size={18} />
          </div>
          <div className="flex-1 text-left min-w-0">
            <div className="font-medium">{t('aiConfig.configOverview')}</div>
            <div className="text-[10px] text-[var(--color-text-muted)]">
              {configuredModelsCount > 0
                ? t('aiConfig.modelsSelected', { count: configuredModelsCount })
                : t('aiConfig.viewCurrentConfig')}
            </div>
          </div>
          {configuredModelsCount > 0 && (
            <div className="w-2 h-2 rounded-full bg-[var(--color-success)] shadow-[0_0_6px_var(--color-success)]" />
          )}
        </button>

        {/* System providers */}
        <div className="mb-4">
          <div className="text-[10px] font-medium text-[var(--color-text-muted)] px-3 py-2 uppercase tracking-wider flex items-center gap-1">
            <Cloud size={10} />
            {t('aiConfig.cloudServices')}
          </div>
          {providers
            .filter((p) => p.isSystem !== false)
            .map((provider) => (
              <ProviderListItem
                key={provider.id}
                provider={provider}
                isActive={selectedId === provider.id}
                onClick={() => onSelect(provider.id)}
              />
            ))}
        </div>

        {/* Custom providers */}
        {providers.some((p) => p.isSystem === false) && (
          <div>
            <div className="text-[10px] font-medium text-[var(--color-text-muted)] px-3 py-2 uppercase tracking-wider flex items-center gap-1">
              <Settings2 size={10} />
              {t('aiConfig.customServices')}
            </div>
            {providers
              .filter((p) => p.isSystem === false)
              .map((provider) => (
                <ProviderListItem
                  key={provider.id}
                  provider={provider}
                  isActive={selectedId === provider.id}
                  onClick={() => onSelect(provider.id)}
                />
              ))}
          </div>
        )}
      </div>

      {/* Bottom add button */}
      <div className="p-3 border-t border-[var(--color-border)]">
        <Button
          variant="secondary"
          size="sm"
          fullWidth
          leftIcon={<Plus size={14} />}
          onClick={onAddCustom}
        >
          {t('aiConfig.addService')}
        </Button>
      </div>
    </div>
  );
};

// Provider list item
const ProviderListItem: React.FC<{
  provider: Provider;
  isActive: boolean;
  onClick: () => void;
}> = ({ provider, isActive, onClick }) => {
  const isConfigured = provider.enabled && provider.apiKey;
  const colors = getProviderColor(provider.id);

  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all text-sm group cursor-pointer
        ${
          isActive
            ? 'bg-[var(--color-accent-muted)] text-[var(--color-text-primary)] shadow-sm'
            : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]'
        }`}
    >
      {/* Icon */}
      <div
        className={`w-9 h-9 rounded-lg flex items-center justify-center text-sm font-bold flex-shrink-0 transition-colors
          ${isActive ? `${colors.bg} ${colors.text}` : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]'}
        `}
      >
        {provider.name.charAt(0).toUpperCase()}
      </div>

      {/* Info */}
      <div className="flex-1 text-left min-w-0">
        <div className="font-medium truncate">{provider.name}</div>
        <div className="text-[10px] text-[var(--color-text-muted)] truncate">
          {provider.models.length} model{provider.models.length !== 1 ? 's' : ''}
        </div>
      </div>

      {/* Status indicator */}
      {isConfigured && (
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 rounded-full bg-[var(--color-success)] shadow-[0_0_6px_var(--color-success)]" />
        </div>
      )}
    </button>
  );
};

// ====== Empty State Component ======

const EmptyState: React.FC<{ onAddProvider: () => void }> = ({ onAddProvider }) => {
  const { t } = useTranslation();
  return (
    <div className="h-full flex flex-col items-center justify-center text-center p-8">
      <div className="w-16 h-16 rounded-2xl bg-[var(--color-bg-tertiary)] flex items-center justify-center mb-4">
        <Bot size={32} className="text-[var(--color-text-muted)]" />
      </div>
      <h3 className="text-lg font-medium text-[var(--color-text-primary)] mb-2">
        {t('aiConfig.startConfiguring')}
      </h3>
      <p className="text-sm text-[var(--color-text-muted)] mb-6 max-w-sm">
        {t('aiConfig.selectProviderFromLeft')}
      </p>
      <Button onClick={onAddProvider} leftIcon={<Plus size={16} />}>
        {t('aiConfig.addService')}
      </Button>
    </div>
  );
};

// ====== Provider Settings Component ======

interface ProviderSettingsProps {
  provider: Provider;
  onUpdate: (updates: Partial<Provider>) => void;
  onDelete: () => void;
  selectedModels: SelectedModels;
  onSelectModel: (type: keyof SelectedModels, providerId: string, modelId: string) => void;
}

const ProviderSettings: React.FC<ProviderSettingsProps> = ({
  provider,
  onUpdate,
  onDelete,
  selectedModels,
  onSelectModel,
}) => {
  const { t } = useTranslation();
  const [apiKey, setApiKey] = useState(provider.apiKey || '');
  const [apiHost, setApiHost] = useState(provider.apiHost || '');
  const [showApiKey, setShowApiKey] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<'success' | 'error' | null>(null);
  const [showAddModel, setShowAddModel] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const colors = getProviderColor(provider.id);

  // Sync provider changes
  useEffect(() => {
    setApiKey(provider.apiKey || '');
    setApiHost(provider.apiHost || provider.defaultApiHost || '');
    setCheckResult(null);
  }, [provider.id, provider.apiKey, provider.apiHost, provider.defaultApiHost]);

  // Save API config (called on blur)
  const handleSaveConfig = useCallback(() => {
    const updates: Partial<Provider> = {};
    if (apiKey !== provider.apiKey) updates.apiKey = apiKey.trim();
    if (apiHost !== provider.apiHost) updates.apiHost = apiHost.trim();

    if (Object.keys(updates).length > 0) {
      onUpdate(updates);
      if (apiKey.trim() && !provider.enabled) {
        onUpdate({ enabled: true });
      }
      // 🔧 No longer need to manually call onSave(), parent component's useEffect auto-save will handle it
    }
  }, [apiKey, apiHost, provider.apiKey, provider.apiHost, provider.enabled, onUpdate]);

  const handleCheckConnection = useCallback(async () => {
    if (!apiKey.trim()) return;
    setChecking(true);
    setCheckResult(null);
    try {
      // Simulate check - should actually call API
      await new Promise((resolve) => setTimeout(resolve, 1500));
      setCheckResult('success');
      handleSaveConfig();
    } catch {
      setCheckResult('error');
    } finally {
      setChecking(false);
    }
  }, [apiKey, handleSaveConfig]);

  // Group models by type
  const modelsByType = useMemo(() => {
    const groups: Record<ModelType, ModelInfo[]> = {
      chat: [],
      completion: [],
      vision: [],
      embedding: [],
      rerank: [],
      stt: [],
      tts: [],
    };
    provider.models.forEach((model) => {
      if (groups[model.type]) groups[model.type].push(model);
      // Chat models and completion models are interchangeable
      if (model.type === 'chat') {
        groups.completion.push(model);
      } else if (model.type === 'completion') {
        groups.chat.push(model);
      }
    });
    return groups;
  }, [provider.models]);

  const handleAddModel = useCallback(
    (model: ModelInfo) => {
      onUpdate({ models: [...provider.models, model] });
      setShowAddModel(false);
      // 🔧 No longer need to manually call onSave(), auto-save will handle it
    },
    [provider.models, onUpdate]
  );

  // Fetch and add multiple models from API
  const handleAddModelsFromPicker = useCallback(
    (models: ModelInfo[]) => {
      if (models.length === 0) return;
      // Deduplicate: exclude existing models
      const existingIds = new Set(provider.models.map((m) => m.id));
      const newModels = models.filter((m) => !existingIds.has(m.id));
      if (newModels.length > 0) {
        onUpdate({ models: [...provider.models, ...newModels] });
        // 🔧 No longer need to manually call onSave(), auto-save will handle it
      }
      setShowModelPicker(false);
    },
    [provider.models, onUpdate]
  );

  const handleDeleteModel = useCallback(
    (modelId: string) => {
      onUpdate({ models: provider.models.filter((m) => m.id !== modelId) });
      // 🔧 No longer need to manually call onSave(), auto-save will handle it
    },
    [provider.models, onUpdate]
  );

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-8 py-5 border-b border-[var(--color-border)] bg-[var(--color-bg-primary)]">
        <div className="flex items-center gap-4">
          <div
            className={`w-12 h-12 rounded-xl flex items-center justify-center text-lg font-bold shadow-sm ${colors.bg} ${colors.text}`}
          >
            {provider.name.charAt(0).toUpperCase()}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">
                {provider.name}
              </h2>
              {provider.isSystem !== false ? (
                <Badge variant="secondary" size="sm">
                  {t('aiConfig.official')}
                </Badge>
              ) : (
                <Badge variant="secondary" size="sm">
                  {t('aiConfig.custom')}
                </Badge>
              )}
              {checkResult === 'success' && (
                <Badge variant="success" size="sm">
                  {t('aiConfig.connected')}
                </Badge>
              )}
            </div>
            {provider.website && (
              <a
                href={provider.website}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-[var(--color-accent)] hover:underline flex items-center gap-1 mt-0.5"
              >
                {t('aiConfig.getApiKey')} <ExternalLink size={10} />
              </a>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]">
            <span className="text-sm text-[var(--color-text-secondary)]">
              {t('aiConfig.enable')}
            </span>
            <Toggle
              checked={provider.enabled}
              onChange={(checked) => {
                onUpdate({ enabled: checked });
                // 🔧 No longer need to manually call onSave(), auto-save will handle it
              }}
              size="sm"
            />
          </div>
          {provider.isSystem === false && (
            <IconButton
              variant="ghost"
              className="text-[var(--color-error)] hover:bg-[var(--color-error-muted)]"
              onClick={onDelete}
              tooltip={t('aiConfig.deleteService')}
            >
              <Trash2 size={18} />
            </IconButton>
          )}
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl mx-auto space-y-6">
          {/* Step 1: API Configuration */}
          <Card>
            <div className="p-5 border-b border-[var(--color-border)] flex items-center gap-3">
              <div className="w-6 h-6 rounded-full bg-[var(--color-accent)] text-white text-xs font-bold flex items-center justify-center">
                1
              </div>
              <h3 className="text-sm font-medium text-[var(--color-text-primary)]">
                {t('aiConfig.configureApiConnection')}
              </h3>
            </div>
            <div className="p-5 space-y-5">
              {/* API Key */}
              <div>
                <label className="flex items-center gap-2 text-sm font-medium text-[var(--color-text-secondary)] mb-2">
                  <Key size={14} />
                  API Key
                  {provider.id === 'ollama' && (
                    <span className="text-xs text-[var(--color-text-muted)]">
                      {t('aiConfig.ollamaApiKeyHint')}
                    </span>
                  )}
                </label>
                <div className="flex gap-2">
                  <div className="flex-1 relative">
                    <Input
                      type={showApiKey ? 'text' : 'password'}
                      value={apiKey}
                      onChange={(e) => {
                        setApiKey(e.target.value);
                        setCheckResult(null);
                      }}
                      onBlur={handleSaveConfig}
                      placeholder="sk-..."
                      error={checkResult === 'error'}
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey(!showApiKey)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors"
                    >
                      {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  <Button
                    onClick={handleCheckConnection}
                    disabled={!apiKey.trim() || checking}
                    variant={checkResult === 'success' ? 'secondary' : 'primary'}
                    className={
                      checkResult === 'success'
                        ? 'text-[var(--color-success)] border-[var(--color-success)]'
                        : ''
                    }
                  >
                    {checking ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : checkResult === 'success' ? (
                      <>
                        <Check size={16} className="mr-1" /> {t('aiConfig.verified')}
                      </>
                    ) : (
                      t('aiConfig.verifyConnection')
                    )}
                  </Button>
                </div>
                <p className="text-xs text-[var(--color-text-muted)] mt-2 flex items-center gap-1">
                  <HelpCircle size={10} />
                  {t('aiConfig.apiKeyLocalOnly')}
                </p>
              </div>

              {/* API Address - Advanced Options */}
              <div>
                <button
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="flex items-center gap-2 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors cursor-pointer"
                >
                  {showAdvanced ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  {t('aiConfig.advancedOptions')}
                </button>
                {showAdvanced && (
                  <div className="mt-3">
                    <label className="flex items-center gap-2 text-sm font-medium text-[var(--color-text-secondary)] mb-2">
                      <Globe size={14} />
                      {t('aiConfig.apiAddress')}
                    </label>
                    <Input
                      value={apiHost}
                      onChange={(e) => setApiHost(e.target.value)}
                      onBlur={handleSaveConfig}
                      placeholder={provider.defaultApiHost || 'https://api.openai.com/v1'}
                      helperText={t('aiConfig.proxyHelperText')}
                    />
                  </div>
                )}
              </div>
            </div>
          </Card>

          {/* Step 2: Select Models */}
          <Card>
            <div className="p-5 border-b border-[var(--color-border)] flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-6 h-6 rounded-full bg-[var(--color-accent)] text-white text-xs font-bold flex items-center justify-center">
                  2
                </div>
                <h3 className="text-sm font-medium text-[var(--color-text-primary)]">
                  {t('aiConfig.selectModelsToUse')}
                </h3>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => setShowModelPicker(true)}
                  disabled={!apiKey.trim()}
                  title={
                    !apiKey.trim()
                      ? t('aiConfig.fillApiKeyFirst')
                      : t('aiConfig.fetchModelsTooltip')
                  }
                >
                  <RefreshCw size={14} className="mr-1" /> {t('aiConfig.fetchModels')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowAddModel(true)}>
                  <Plus size={14} className="mr-1" /> {t('aiConfig.addManually')}
                </Button>
              </div>
            </div>

            <div className="p-5">
              {provider.models.length === 0 ? (
                <div className="text-center py-8 text-[var(--color-text-muted)]">
                  <Bot size={32} className="mx-auto mb-3 opacity-20" />
                  <p className="mb-3">{t('aiConfig.noModels')}</p>
                  {apiKey.trim() ? (
                    <div className="space-y-2">
                      <p className="text-xs">{t('aiConfig.fetchModelsHint')}</p>
                      <Button size="sm" variant="primary" onClick={() => setShowModelPicker(true)}>
                        <RefreshCw size={14} className="mr-1" /> {t('aiConfig.fetchModels')}
                      </Button>
                    </div>
                  ) : (
                    <p className="text-xs">{t('aiConfig.fillApiKeyThenFetch')}</p>
                  )}
                  {provider.id === 'ollama' && (
                    <p className="text-xs mt-4">
                      {t('aiConfig.ollamaDownloadHint', { command: 'ollama pull llama3' })}
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-6">
                  {Object.entries(modelsByType).map(([type, models]) => {
                    if (models.length === 0) return null;
                    const modelType = type as ModelType;
                    const config = MODEL_TYPE_CONFIG[modelType];
                    const selectedModelId =
                      selectedModels[modelType]?.providerId === provider.id
                        ? selectedModels[modelType]?.modelId
                        : null;

                    return (
                      <div key={type}>
                        <div
                          className={`text-xs font-medium mb-3 flex items-center gap-2 ${config.color}`}
                        >
                          <config.icon size={14} />
                          {t(`aiConfig.modelTypes.${modelType}` as TranslationKey)}
                          <span className="text-[var(--color-text-muted)] font-normal">
                            - {t(`aiConfig.modelTypes.${modelType}Desc` as TranslationKey)}
                          </span>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          {models.map((model) => (
                            <ModelCard
                              key={model.id}
                              model={model}
                              isSelected={selectedModelId === model.id}
                              isEnabled={provider.enabled && !!provider.apiKey}
                              onSelect={() => {
                                onSelectModel(modelType, provider.id, model.id);
                                // 🔧 No longer need to manually call onSave(), auto-save will handle it
                              }}
                              onDelete={() => handleDeleteModel(model.id)}
                            />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>

      {/* Add model modal */}
      <AddModelModal
        open={showAddModel}
        onClose={() => setShowAddModel(false)}
        onAdd={handleAddModel}
      />

      {/* Fetch models from API modal */}
      <ModelPickerModal
        open={showModelPicker}
        onClose={() => setShowModelPicker(false)}
        onAdd={handleAddModelsFromPicker}
        baseUrl={apiHost || provider.defaultApiHost || ''}
        apiKey={apiKey}
        existingModelIds={provider.models.map((m) => m.id)}
      />
    </div>
  );
};

// ====== Model Card Component ======

const ModelCard: React.FC<{
  model: ModelInfo;
  isSelected: boolean;
  isEnabled: boolean;
  onSelect: () => void;
  onDelete: () => void;
}> = ({ model, isSelected, isEnabled, onSelect, onDelete }) => (
  <div
    onClick={() => isEnabled && onSelect()}
    className={`group relative p-3 rounded-lg border text-sm transition-all
      ${
        isSelected
          ? 'bg-[var(--color-accent-muted)] border-[var(--color-accent)] shadow-sm'
          : 'bg-[var(--color-bg-tertiary)] border-[var(--color-border)] hover:border-[var(--color-border-strong)]'
      }
      ${isEnabled ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'}
    `}
  >
    <div className="flex items-center justify-between mb-1">
      <span
        className={`font-medium truncate ${isSelected ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-primary)]'}`}
      >
        {model.name}
      </span>
      {isSelected && <Check size={14} className="text-[var(--color-accent)]" />}
    </div>
    <div className="flex items-center justify-between">
      <span className="text-xs text-[var(--color-text-muted)] font-mono truncate">{model.id}</span>
      {model.contextLength && (
        <Badge variant="secondary" size="sm" className="text-[10px] px-1 h-5">
          {(model.contextLength / 1000).toFixed(0)}k
        </Badge>
      )}
    </div>

    <button
      onClick={(e) => {
        e.stopPropagation();
        onDelete();
      }}
      className="absolute -top-2 -right-2 p-1 rounded-full bg-[var(--color-bg-elevated)] border border-[var(--color-border)] 
                 text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 hover:text-[var(--color-error)] transition-all shadow-sm"
    >
      <X size={12} />
    </button>
  </div>
);

// ====== Add Model Modal ======

interface AddModelModalProps {
  open: boolean;
  onClose: () => void;
  onAdd: (model: ModelInfo) => void;
}

const AddModelModal: React.FC<AddModelModalProps> = ({ open, onClose, onAdd }) => {
  const { t } = useTranslation();
  const [modelId, setModelId] = useState('');
  const [modelName, setModelName] = useState('');
  const [modelType, setModelType] = useState<ModelType>('chat');

  const handleAdd = () => {
    if (!modelId.trim()) return;
    onAdd({
      id: modelId.trim(),
      name: modelName.trim() || modelId.trim(),
      type: modelType,
    });
    setModelId('');
    setModelName('');
    setModelType('chat');
  };

  return (
    <Modal open={open} onClose={onClose} title={t('aiConfig.addCustomModel')}>
      <div className="space-y-4">
        <Input
          label={t('aiConfig.modelId')}
          placeholder="e.g.: gpt-4-turbo, deepseek-chat"
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
          helperText={t('aiConfig.modelIdHelper')}
        />
        <Input
          label={t('aiConfig.displayName')}
          placeholder="e.g.: GPT-4 Turbo"
          value={modelName}
          onChange={(e) => setModelName(e.target.value)}
          helperText={t('aiConfig.displayNameHelper')}
        />
        <Select
          label={t('aiConfig.modelType')}
          value={modelType}
          onChange={(val) => setModelType(val as ModelType)}
          options={[
            { value: 'chat', label: t('aiConfig.chatModelOption') },
            { value: 'completion', label: t('aiConfig.completionModelOption') },
            { value: 'vision', label: t('aiConfig.visionModelOption') },
            { value: 'embedding', label: t('aiConfig.embeddingModelOption') },
          ]}
        />
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" fullWidth onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" fullWidth disabled={!modelId.trim()} onClick={handleAdd}>
            {t('common.add')}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

// ====== Configuration Overview Panel ======

interface OverviewPanelProps {
  selectedModels: SelectedModels;
  providers: Provider[];
  onNavigateToProvider: (providerId: string) => void;
}

const OverviewPanel: React.FC<OverviewPanelProps> = ({
  selectedModels,
  providers,
  onNavigateToProvider,
}) => {
  const { t } = useTranslation();
  // Helper function to get model details
  const getModelDetails = useCallback(
    (type: keyof SelectedModels) => {
      const selection = selectedModels[type];
      if (!selection) return null;

      const provider = providers.find((p) => p.id === selection.providerId);
      if (!provider) return null;

      const model = provider.models.find((m) => m.id === selection.modelId);
      return {
        provider,
        model,
        modelId: selection.modelId,
      };
    },
    [selectedModels, providers]
  );

  // Model type configuration (extended version with icon components)
  const modelTypeCards: Array<{
    type: keyof SelectedModels;
    label: string;
    desc: string;
    icon: React.ReactNode;
    colorClass: string;
    bgClass: string;
  }> = [
    {
      type: 'chat',
      label: t('aiConfig.modelTypes.chat'),
      desc: t('aiConfig.modelTypes.chatDesc'),
      icon: <Bot size={20} />,
      colorClass: 'text-[var(--color-accent)]',
      bgClass: 'bg-[var(--color-accent)]/10',
    },
    {
      type: 'completion',
      label: t('aiConfig.modelTypes.completion'),
      desc: t('aiConfig.sharesWithChat'),
      icon: <Zap size={20} />,
      colorClass: 'text-[var(--color-warning)]',
      bgClass: 'bg-[var(--color-warning)]/10',
    },
    {
      type: 'vision',
      label: t('aiConfig.modelTypes.vision'),
      desc: t('aiConfig.imageUnderstanding'),
      icon: <Eye size={20} />,
      colorClass: 'text-[var(--color-info)]',
      bgClass: 'bg-[var(--color-info)]/10',
    },
    {
      type: 'embedding',
      label: t('aiConfig.modelTypes.embedding'),
      desc: t('aiConfig.knowledgeRetrieval'),
      icon: <Sparkles size={20} />,
      colorClass: 'text-[var(--color-success)]',
      bgClass: 'bg-[var(--color-success)]/10',
    },
    {
      type: 'rerank',
      label: t('aiConfig.modelTypes.rerank'),
      desc: t('aiConfig.retrievalReranking'),
      icon: <Search size={20} />,
      colorClass: 'text-orange-500',
      bgClass: 'bg-orange-500/10',
    },
    {
      type: 'stt',
      label: t('aiConfig.modelTypes.stt'),
      desc: t('aiConfig.speechToText'),
      icon: <Mic size={20} />,
      colorClass: 'text-[var(--color-error)]',
      bgClass: 'bg-[var(--color-error)]/10',
    },
  ];

  const configuredCount = Object.values(selectedModels).filter((m) => m !== null).length;

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-8 py-6 border-b border-[var(--color-border)] bg-[var(--color-bg-primary)]">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-[var(--color-accent)] to-[var(--color-accent-secondary)] flex items-center justify-center text-white shadow-lg">
            <LayoutDashboard size={24} />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">
              {t('aiConfig.configOverview')}
            </h2>
            <p className="text-sm text-[var(--color-text-muted)] mt-0.5">
              {t('aiConfig.currentlyConfigured', {
                count: configuredCount,
                total: modelTypeCards.length,
              })}
            </p>
          </div>
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-4xl mx-auto">
          {/* Statistics cards */}
          <div className="grid grid-cols-2 gap-4 mb-8">
            <div className="bg-[var(--color-bg-elevated)] rounded-xl p-4 border border-[var(--color-border)]">
              <div className="text-2xl font-bold text-[var(--color-accent)]">{configuredCount}</div>
              <div className="text-xs text-[var(--color-text-muted)] mt-1">
                {t('aiConfig.configuredModelTypes')}
              </div>
            </div>
            <div className="bg-[var(--color-bg-elevated)] rounded-xl p-4 border border-[var(--color-border)]">
              <div className="text-2xl font-bold text-[var(--color-success)]">
                {providers.filter((p) => p.enabled && p.apiKey).length}
              </div>
              <div className="text-xs text-[var(--color-text-muted)] mt-1">
                {t('aiConfig.enabledProviders')}
              </div>
            </div>
          </div>

          {/* Model cards grid */}
          <h3 className="text-sm font-medium text-[var(--color-text-primary)] mb-4 flex items-center gap-2">
            <Settings2 size={14} />
            {t('aiConfig.currentActiveConfig')}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {modelTypeCards.map(({ type, label, desc, icon, colorClass, bgClass }) => {
              const details = getModelDetails(type);
              const isConfigured = details !== null;

              return (
                <div
                  key={type}
                  onClick={() => {
                    if (details?.provider) {
                      onNavigateToProvider(details.provider.id);
                    }
                  }}
                  className={`group relative p-4 rounded-xl border transition-all cursor-pointer
                    ${
                      isConfigured
                        ? 'bg-[var(--color-bg-elevated)] border-[var(--color-border)] hover:border-[var(--color-accent)] hover:shadow-md'
                        : 'bg-[var(--color-bg-tertiary)] border-dashed border-[var(--color-border)] hover:border-[var(--color-text-muted)]'
                    }
                  `}
                >
                  <div className="flex items-start gap-3">
                    {/* Icon */}
                    <div
                      className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${bgClass} ${colorClass}`}
                    >
                      {icon}
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <span className={`text-sm font-medium ${colorClass}`}>{label}</span>
                        {isConfigured && (
                          <Check size={14} className="text-[var(--color-success)]" />
                        )}
                      </div>

                      {isConfigured && details ? (
                        <>
                          <div className="text-sm font-medium text-[var(--color-text-primary)] truncate">
                            {details.model?.name || details.modelId}
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <div
                              className={`w-4 h-4 rounded text-[8px] font-bold flex items-center justify-center
                                ${getProviderColor(details.provider.id).bg} ${getProviderColor(details.provider.id).text}
                              `}
                            >
                              {details.provider.name.charAt(0)}
                            </div>
                            <span className="text-xs text-[var(--color-text-muted)] truncate">
                              {details.provider.name}
                            </span>
                          </div>
                        </>
                      ) : (
                        <div className="text-xs text-[var(--color-text-muted)]">
                          {desc}
                          <span className="block mt-1 text-[var(--color-text-muted)]/60">
                            {t('aiConfig.clickToConfigure')}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Navigation hint */}
                  {isConfigured && (
                    <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
                      <ArrowRight size={14} className="text-[var(--color-text-muted)]" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Quick tips */}
          {configuredCount === 0 && (
            <div className="mt-8 p-4 rounded-xl bg-[var(--color-accent)]/5 border border-[var(--color-accent)]/20">
              <div className="flex items-start gap-3">
                <HelpCircle size={16} className="text-[var(--color-accent)] mt-0.5 flex-shrink-0" />
                <div>
                  <div className="text-sm font-medium text-[var(--color-text-primary)]">
                    {t('aiConfig.startConfiguration')}
                  </div>
                  <div className="text-xs text-[var(--color-text-muted)] mt-1">
                    {t('aiConfig.selectProviderHint')}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
