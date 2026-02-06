/**
 * @file RAGTab.tsx - RAG Settings Tab
 * @description Configures knowledge base retrieval parameters including Embedding and Rerank models
 */

import { Database, RefreshCw, Zap } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { useTranslation } from '../../locales';
import { getSettingsService } from '../../services/core/ServiceRegistry';
import { useSelectedKnowledgeBaseId, useSettings } from '../../services/core/hooks';
import type { RerankProvider } from '../../types/app';
import type { ModelInfo, Provider } from '../../types/provider';
import { Button } from '../ui';
import {
  SectionTitle,
  SettingCard,
  SettingItem,
  Toggle,
  inputClassName,
  selectClassName,
} from './SettingsUI';

async function getConfiguredProvidersAsync(): Promise<Provider[]> {
  try {
    const settingsService = getSettingsService();
    const config = await settingsService.getAIConfig();
    return (config.providers || []) as Provider[];
  } catch (e) {
    console.error('读取 AI 配置失败:', e);
  }
  return [];
}

function getRerankModels(providers: Provider[]): Array<{
  providerId: string;
  providerName: string;
  model: ModelInfo;
  apiKey: string;
  baseUrl: string;
}> {
  const result: Array<{
    providerId: string;
    providerName: string;
    model: ModelInfo;
    apiKey: string;
    baseUrl: string;
  }> = [];

  for (const provider of providers) {
    if (!provider.enabled || !provider.apiKey) continue;

    const rerankModels = provider.models.filter((m) => m.type === 'rerank');
    for (const model of rerankModels) {
      result.push({
        providerId: provider.id,
        providerName: provider.name,
        model,
        apiKey: provider.apiKey,
        baseUrl: provider.apiHost || (provider as { defaultApiHost?: string }).defaultApiHost || '',
      });
    }
  }

  return result;
}

interface SearchResultItem {
  chunkId: string;
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
  filename?: string;
  source?: string;
}

const KnowledgeDiagnostics: React.FC = () => {
  const { t } = useTranslation();
  const [diagnostics, setDiagnostics] = useState<{
    totalChunks: number;
    totalEmbeddings: number;
    ftsRecords: number;
    embeddingDimensions: number[];
    libraryStats: Array<{ libraryId: string; chunks: number; embeddings: number }>;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [testQuery, setTestQuery] = useState('');
  const [testResults, setTestResults] = useState<SearchResultItem[] | null>(null);
  const [rebuildingFTS, setRebuildingFTS] = useState(false);
  const [generatingEmbeddings, setGeneratingEmbeddings] = useState(false);
  // Using the new service architecture
  const globalSelectedKnowledgeBaseId = useSelectedKnowledgeBaseId();

  const [libraries, setLibraries] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedLibraryId, setSelectedLibraryId] = useState<string | null>(
    globalSelectedKnowledgeBaseId
  );

  React.useEffect(() => {
    const loadLibraries = async () => {
      try {
        const libs = await api.knowledge.getLibraries();
        setLibraries(libs.map((lib) => ({ id: lib.id, name: lib.name })));
      } catch (error) {
        console.error('加载知识库列表失败:', error);
      }
    };
    loadLibraries();
  }, []);

  // Sync with global selection
  React.useEffect(() => {
    if (globalSelectedKnowledgeBaseId && !selectedLibraryId) {
      setSelectedLibraryId(globalSelectedKnowledgeBaseId);
    }
  }, [globalSelectedKnowledgeBaseId, selectedLibraryId]);

  const runDiagnostics = async () => {
    setLoading(true);
    try {
      const result = await api.knowledge.getDiagnostics(selectedLibraryId || undefined);
      setDiagnostics({
        ...result,
        embeddingDimensions: result.embeddingDimensions || [],
        libraryStats: result.libraryStats || [],
      });
    } catch (error) {
      console.error('诊断失败:', error);
    } finally {
      setLoading(false);
    }
  };

  const testSearch = async () => {
    if (!testQuery.trim()) return;
    setLoading(true);
    setTestResults(null);
    try {
      const results = await api.knowledge.search({
        query: testQuery,
        libraryIds: selectedLibraryId ? [selectedLibraryId] : undefined,
        topK: 5,
        scoreThreshold: 0.1,
        retrieverType: 'hybrid',
      });
      setTestResults(results.results);
    } catch (error) {
      console.error('搜索测试失败:', error);
      setTestResults([]);
    } finally {
      setLoading(false);
    }
  };

  const rebuildFTSIndex = async () => {
    setRebuildingFTS(true);
    try {
      const result = await api.knowledge.rebuildFTS();
      alert(
        result.success
          ? t('rag.diagnostics.ftsRebuildSuccess', { count: result.recordCount })
          : t('rag.diagnostics.ftsRebuildFailed')
      );
      await runDiagnostics();
    } catch (error) {
      console.error('重建 FTS 失败:', error);
      alert(t('rag.diagnostics.ftsRebuildFailed'));
    } finally {
      setRebuildingFTS(false);
    }
  };

  const generateEmbeddings = async () => {
    setGeneratingEmbeddings(true);
    try {
      const result = await api.knowledge.generateEmbeddings(selectedLibraryId || undefined);
      if (result.success) {
        alert(t('rag.diagnostics.embeddingSuccess', { count: result.processed }));
      } else {
        alert(t('rag.diagnostics.embeddingFailed'));
      }
      await runDiagnostics();
    } catch (error) {
      console.error('生成嵌入失败:', error);
      alert(
        t('rag.diagnostics.embeddingError', {
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      );
    } finally {
      setGeneratingEmbeddings(false);
    }
  };

  const missingEmbeddings = diagnostics ? diagnostics.totalChunks - diagnostics.totalEmbeddings : 0;

  return (
    <>
      <SectionTitle>{`🔧 ${t('rag.diagnostics.title')}`}</SectionTitle>
      <p className="text-xs text-[var(--color-text-muted)] mb-3">{t('rag.diagnostics.desc')}</p>

      <div className="flex gap-2 mb-3">
        <Button
          onClick={runDiagnostics}
          disabled={loading}
          variant="secondary"
          size="sm"
          leftIcon={
            loading ? <RefreshCw size={12} className="animate-spin" /> : <Database size={12} />
          }
          className="flex-1"
        >
          {t('rag.diagnostics.runDiagnostics')}
        </Button>
        <Button
          onClick={rebuildFTSIndex}
          disabled={rebuildingFTS}
          variant="secondary"
          size="sm"
          leftIcon={
            rebuildingFTS ? (
              <RefreshCw size={12} className="animate-spin" />
            ) : (
              <RefreshCw size={12} />
            )
          }
          className="flex-1"
        >
          {t('rag.diagnostics.rebuildFTS')}
        </Button>
      </div>

      {diagnostics && missingEmbeddings > 0 && (
        <Button
          onClick={generateEmbeddings}
          disabled={generatingEmbeddings}
          variant="magic"
          size="sm"
          fullWidth
          leftIcon={
            generatingEmbeddings ? (
              <RefreshCw size={12} className="animate-spin" />
            ) : (
              <Zap size={12} />
            )
          }
          className="mb-3"
        >
          {generatingEmbeddings
            ? t('rag.diagnostics.generatingEmbeddings')
            : t('rag.diagnostics.generateEmbeddings', { count: missingEmbeddings })}
        </Button>
      )}

      {diagnostics && (
        <SettingCard className="mb-3 text-xs space-y-1">
          <div className="flex justify-between">
            <span className="text-[var(--color-text-muted)]">
              {t('rag.diagnostics.totalChunks')}
            </span>
            <span
              className={
                diagnostics.totalChunks > 0
                  ? 'text-[var(--color-success)]'
                  : 'text-[var(--color-error)]'
              }
            >
              {diagnostics.totalChunks}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--color-text-muted)]">
              {t('rag.diagnostics.totalEmbeddings')}
            </span>
            <span
              className={
                diagnostics.totalEmbeddings > 0
                  ? 'text-[var(--color-success)]'
                  : 'text-[var(--color-warning)]'
              }
            >
              {diagnostics.totalEmbeddings}
              {missingEmbeddings > 0 && (
                <span className="text-[var(--color-warning)] ml-1">(-{missingEmbeddings})</span>
              )}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--color-text-muted)]">
              {t('rag.diagnostics.ftsRecords')}
            </span>
            <span
              className={
                diagnostics.ftsRecords > 0
                  ? 'text-[var(--color-success)]'
                  : 'text-[var(--color-error)]'
              }
            >
              {diagnostics.ftsRecords}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--color-text-muted)]">
              {t('rag.diagnostics.embeddingDimensions')}
            </span>
            <span className="text-[var(--color-text-secondary)]">
              {diagnostics.embeddingDimensions.join(', ') || t('rag.diagnostics.none')}
            </span>
          </div>

          {diagnostics.totalChunks > 0 && diagnostics.ftsRecords === 0 && (
            <div className="mt-2 p-2 bg-[var(--color-error-muted)] border border-[var(--color-error)]/30 rounded text-[var(--color-error)]">
              ⚠️ {t('rag.diagnostics.ftsEmpty')}
            </div>
          )}

          {diagnostics.totalChunks > 0 && diagnostics.totalEmbeddings === 0 && (
            <div className="mt-2 p-2 bg-[var(--color-warning-muted)] border border-[var(--color-warning)]/30 rounded text-[var(--color-warning)]">
              ⚠️ {t('rag.diagnostics.noEmbeddings')}
            </div>
          )}
        </SettingCard>
      )}

      <SectionTitle>{`🔍 ${t('rag.diagnostics.searchTest')}`}</SectionTitle>

      <div className="mb-3">
        <label className="block text-xs text-[var(--color-text-muted)] mb-1">
          {t('rag.diagnostics.selectKnowledgeBase')}
        </label>
        <select
          value={selectedLibraryId || ''}
          onChange={(e) => setSelectedLibraryId(e.target.value || null)}
          className={selectClassName}
        >
          <option value="">{t('rag.diagnostics.allKnowledgeBases')}</option>
          {libraries.map((lib) => (
            <option key={lib.id} value={lib.id}>
              {lib.name}
            </option>
          ))}
        </select>
        {libraries.length === 0 && (
          <p className="text-xs text-[var(--color-warning)] mt-1">
            ⚠️ {t('rag.diagnostics.noKnowledgeBases')}
          </p>
        )}
      </div>

      <div className="flex gap-2 mb-2">
        <input
          type="text"
          value={testQuery}
          onChange={(e) => setTestQuery(e.target.value)}
          placeholder={t('rag.diagnostics.enterTestQuery')}
          className={`${inputClassName} flex-1`}
          onKeyDown={(e) => e.key === 'Enter' && testSearch()}
        />
        <Button
          onClick={testSearch}
          disabled={loading || !testQuery.trim()}
          variant="primary"
          size="sm"
        >
          {t('rag.diagnostics.search')}
        </Button>
      </div>

      {testResults !== null && (
        <SettingCard className="text-xs max-h-48 overflow-y-auto">
          {testResults.length === 0 ? (
            <div className="text-[var(--color-error)]">
              ❌ {t('rag.diagnostics.noResults')}
              <ul className="list-disc ml-4 mt-1 text-[var(--color-text-muted)]">
                <li>{t('rag.diagnostics.noResultsHint1')}</li>
                <li>{t('rag.diagnostics.noResultsHint2')}</li>
                <li>{t('rag.diagnostics.noResultsHint3')}</li>
              </ul>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="text-[var(--color-success)]">
                ✓ {t('rag.diagnostics.foundResults', { count: testResults.length })}
              </div>
              {testResults.map((r) => (
                <div
                  key={r.chunkId}
                  className="p-2 bg-[var(--color-bg-hover)] rounded border-l-2 border-[var(--color-accent)]"
                >
                  <div className="flex justify-between text-[var(--color-text-muted)] mb-1">
                    <span>{r.filename}</span>
                    <span>
                      {t('rag.diagnostics.relevance')} {(r.score * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div className="text-[var(--color-text-secondary)] line-clamp-2">
                    {r.content?.slice(0, 150)}...
                  </div>
                </div>
              ))}
            </div>
          )}
        </SettingCard>
      )}
    </>
  );
};

export const RAGTab: React.FC = () => {
  const { t } = useTranslation();
  // Using the new service architecture
  const settings = useSettings();
  const settingsService = getSettingsService();

  const [providers, setProviders] = useState<Provider[]>([]);

  useEffect(() => {
    const loadProviders = async () => {
      const loadedProviders = await getConfiguredProvidersAsync();
      setProviders(loadedProviders);
    };
    loadProviders();

    // Listen to AI config changes from SettingsService (from main process)
    const disposable = settingsService.onDidChangeAIProviders(() => {
      loadProviders();
    });

    return () => {
      disposable.dispose();
    };
  }, [settingsService]);

  const rerankModels = useMemo(() => getRerankModels(providers), [providers]);

  /**
   * Update chunking config for all existing libraries
   * Only updates config, doesn't reprocess existing documents (non-destructive update principle)
   *
   * Note: Backend updateLibrary is shallow merge, need to preserve other fields in existing chunkingConfig
   */
  const updateAllLibrariesChunking = async (chunkSize: number, chunkOverlap: number) => {
    try {
      const libraries = await api.knowledge.getLibraries();
      await Promise.all(
        libraries.map((lib) =>
          api.knowledge.updateLibrary(lib.id, {
            // Deep merge: preserve existing separators and enableMultimodal config
            chunkingConfig: {
              ...lib.chunkingConfig,
              chunkSize,
              chunkOverlap,
            },
          })
        )
      );
    } catch (error) {
      console.error('[RAGTab] 更新知识库分块配置失败:', error);
    }
  };

  return (
    <>
      <SectionTitle>{t('rag.title')}</SectionTitle>
      <Toggle
        label={t('rag.enableKnowledge')}
        desc={t('rag.enableKnowledgeDesc')}
        checked={settings.rag.enabled}
        onChange={(v) => settingsService.updateSettings({ rag: { ...settings.rag, enabled: v } })}
      />

      <SettingItem label={`${t('rag.maxResults')} ${settings.rag.maxResults}`}>
        <input
          type="range"
          min="1"
          max="20"
          value={settings.rag.maxResults}
          onChange={(e) =>
            settingsService.updateSettings({
              rag: { ...settings.rag, maxResults: Number.parseInt(e.target.value) },
            })
          }
          className="w-full accent-[var(--color-accent)]"
        />
      </SettingItem>

      <SettingItem label={`${t('rag.scoreThreshold')} ${settings.rag.scoreThreshold}`}>
        <input
          type="range"
          min="0"
          max="1"
          step="0.1"
          value={settings.rag.scoreThreshold}
          onChange={(e) =>
            settingsService.updateSettings({
              rag: { ...settings.rag, scoreThreshold: Number.parseFloat(e.target.value) },
            })
          }
          className="w-full accent-[var(--color-accent)]"
        />
      </SettingItem>

      <SectionTitle>{t('rag.localConfig')}</SectionTitle>
      <SettingItem label={`${t('rag.chunkSize')} ${settings.rag.local.chunkSize}`}>
        <input
          type="range"
          min="200"
          max="2000"
          step="100"
          value={settings.rag.local.chunkSize}
          onChange={(e) => {
            const newChunkSize = Number.parseInt(e.target.value);
            settingsService.updateSettings({
              rag: {
                ...settings.rag,
                local: { ...settings.rag.local, chunkSize: newChunkSize },
              },
            });
            // Sync chunking config to all existing libraries
            updateAllLibrariesChunking(newChunkSize, settings.rag.local.chunkOverlap);
          }}
          className="w-full accent-[var(--color-accent)]"
        />
      </SettingItem>
      <SettingItem label={`${t('rag.chunkOverlap')} ${settings.rag.local.chunkOverlap}`}>
        <input
          type="range"
          min="0"
          max="500"
          step="50"
          value={settings.rag.local.chunkOverlap}
          onChange={(e) => {
            const newChunkOverlap = Number.parseInt(e.target.value);
            settingsService.updateSettings({
              rag: {
                ...settings.rag,
                local: { ...settings.rag.local, chunkOverlap: newChunkOverlap },
              },
            });
            // Sync chunking config to all existing libraries
            updateAllLibrariesChunking(settings.rag.local.chunkSize, newChunkOverlap);
          }}
          className="w-full accent-[var(--color-accent)]"
        />
      </SettingItem>
      <Toggle
        label={t('rag.hybridSearch')}
        desc={t('rag.hybridSearchDesc')}
        checked={settings.rag.local.useHybridSearch}
        onChange={(v) =>
          settingsService.updateSettings({
            rag: { ...settings.rag, local: { ...settings.rag.local, useHybridSearch: v } },
          })
        }
      />

      <SectionTitle>{`🚀 ${t('rag.advancedTitle')}`}</SectionTitle>
      <p className="text-xs text-[var(--color-text-muted)] mb-3">{t('rag.advancedDesc')}</p>

      <Toggle
        label={t('rag.queryRewrite')}
        desc={t('rag.queryRewriteDesc')}
        checked={settings.rag.advanced?.enableQueryRewrite ?? false}
        onChange={(v) =>
          settingsService.updateSettings({
            rag: {
              ...settings.rag,
              advanced: { ...settings.rag.advanced, enableQueryRewrite: v },
            },
          })
        }
      />

      <Toggle
        label={t('rag.rerank')}
        desc={t('rag.rerankDesc')}
        checked={settings.rag.advanced?.enableRerank ?? false}
        onChange={(v) =>
          settingsService.updateSettings({
            rag: {
              ...settings.rag,
              advanced: { ...settings.rag.advanced, enableRerank: v },
            },
          })
        }
      />

      {settings.rag.advanced?.enableRerank && (
        <div className="ml-4 pl-3 border-l-2 border-[var(--color-accent)]/30 space-y-2 mb-3">
          {rerankModels.length > 0 ? (
            <>
              <SettingItem label={t('rag.rerankModel')}>
                <select
                  value={`${settings.rag.advanced?.rerankProvider ?? ''}|${settings.rag.advanced?.rerankModel ?? ''}`}
                  onChange={(e) => {
                    const [providerId, modelId] = e.target.value.split('|');
                    const selectedModel = rerankModels.find(
                      (m) => m.providerId === providerId && m.model.id === modelId
                    );
                    settingsService.updateSettings({
                      rag: {
                        ...settings.rag,
                        advanced: {
                          ...settings.rag.advanced,
                          rerankProvider: providerId as
                            | 'dashscope'
                            | 'cohere'
                            | 'jina'
                            | 'openai'
                            | 'local'
                            | 'siliconflow'
                            | 'aihubmix'
                            | 'custom',
                          rerankModel: modelId,
                          // Save API config for knowledge base service to use
                          rerankApiKey: selectedModel?.apiKey,
                          rerankBaseUrl: selectedModel?.baseUrl,
                        },
                      },
                    });
                  }}
                  className={selectClassName}
                >
                  <option value="|">{t('rag.selectRerankModel')}</option>
                  {rerankModels.map((item) => (
                    <option
                      key={`${item.providerId}|${item.model.id}`}
                      value={`${item.providerId}|${item.model.id}`}
                    >
                      {item.providerName} - {item.model.name || item.model.id}
                    </option>
                  ))}
                </select>
              </SettingItem>
              <p className="text-xs text-[var(--color-text-muted)]">{t('rag.rerankModelHint')}</p>
            </>
          ) : (
            <div className="p-3 bg-[var(--color-warning-muted)] rounded-lg border border-[var(--color-warning)]/30">
              <p className="text-xs text-[var(--color-warning)]">⚠️ {t('rag.noRerankModel')}</p>
              <p className="text-xs text-[var(--color-text-muted)] mt-1">
                {t('rag.noRerankModelHint')}
              </p>
            </div>
          )}

          <Toggle
            label={t('rag.localKeywordRerank')}
            desc={t('rag.localKeywordRerankDesc')}
            checked={settings.rag.advanced?.rerankProvider === 'local'}
            onChange={(v) =>
              settingsService.updateSettings({
                rag: {
                  ...settings.rag,
                  advanced: {
                    ...settings.rag.advanced,
                    rerankProvider: v
                      ? 'local'
                      : (rerankModels[0]?.providerId as RerankProvider) || undefined,
                    rerankModel: v ? 'keyword-bm25' : rerankModels[0]?.model.id || '',
                  },
                },
              })
            }
          />
        </div>
      )}

      <Toggle
        label={t('rag.contextRouting')}
        desc={t('rag.contextRoutingDesc')}
        checked={settings.rag.advanced?.enableContextRouting ?? false}
        onChange={(v) =>
          settingsService.updateSettings({
            rag: {
              ...settings.rag,
              advanced: { ...settings.rag.advanced, enableContextRouting: v },
            },
          })
        }
      />

      <Toggle
        label={t('rag.bilingualSearch')}
        desc={t('rag.bilingualSearchDesc')}
        checked={settings.rag.advanced?.enableBilingualSearch ?? false}
        onChange={(v) =>
          settingsService.updateSettings({
            rag: {
              ...settings.rag,
              advanced: { ...settings.rag.advanced, enableBilingualSearch: v },
            },
          })
        }
      />

      <KnowledgeDiagnostics />
    </>
  );
};
