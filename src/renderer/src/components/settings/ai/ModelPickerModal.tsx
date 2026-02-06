/**
 * @file ModelPickerModal.tsx - Model Picker Modal
 * @description AI model selection modal, supporting search, filtering, and batch addition
 */

import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  Filter,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  Zap,
} from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../../api';
import type { ModelInfo, ModelType } from '../../../types/provider';
import { Badge, Button, Input, Modal } from '../../ui';

// ====== Type Definitions ======

interface APIModel {
  id: string;
  object?: string;
  owned_by?: string;
  created?: number;
}

interface ModelPickerModalProps {
  open: boolean;
  onClose: () => void;
  onAdd: (models: ModelInfo[]) => void;
  baseUrl: string;
  apiKey: string;
  existingModelIds: string[];
}

// ====== Model Type Inference Rules ======
// 🔧 Optimization: Adjust priority so common chat models (e.g., gpt-4o) are prioritized as chat rather than vision
// Rationale: Most users use these models for conversation, vision capability is supplementary

const MODEL_TYPE_PATTERNS: Array<{ pattern: RegExp; type: ModelType; priority: number }> = [
  // Embedding models - Highest priority, explicit identifiers
  { pattern: /embed|bge|gte|e5|embedding/i, type: 'embedding', priority: 10 },
  // Rerank models - Highest priority, explicit identifiers
  { pattern: /rerank|reranker/i, type: 'rerank', priority: 10 },
  // TTS models - Highest priority, explicit identifiers
  { pattern: /tts|text-to-speech|speech-synthesis/i, type: 'tts', priority: 10 },
  // STT models - Highest priority, explicit identifiers
  { pattern: /whisper|stt|speech-to-text|sensevoice|asr/i, type: 'stt', priority: 10 },
  // Vision models - Only match explicit vision-only models, exclude gpt-4o/claude (mainly used for chat)
  {
    pattern: /\bvl\b|vision|visual|llava|internvl|qwen2-vl|pixtral/i,
    type: 'vision',
    priority: 8,
  },
  // Code/Completion models
  {
    pattern: /coder|codestral|code-|starcoder|codegen|deepseek-coder|fim|fill-in/i,
    type: 'completion',
    priority: 8,
  },
  // Chat models (default) - Multimodal models like gpt-4o, claude are categorized here
  {
    pattern: /chat|instruct|turbo|gpt|claude|qwen|llama|mistral|gemma|yi-|glm|moonshot|deepseek/i,
    type: 'chat',
    priority: 1,
  },
];

function inferModelType(modelId: string): ModelType {
  let bestMatch: { type: ModelType; priority: number } | null = null;

  for (const rule of MODEL_TYPE_PATTERNS) {
    if (rule.pattern.test(modelId)) {
      if (!bestMatch || rule.priority > bestMatch.priority) {
        bestMatch = { type: rule.type, priority: rule.priority };
      }
    }
  }

  return bestMatch?.type || 'chat';
}

// ====== Model Grouping Rules ======

const MODEL_FAMILY_PATTERNS: Array<{ pattern: RegExp; family: string; displayName: string }> = [
  { pattern: /^gpt-/i, family: 'openai', displayName: 'OpenAI GPT' },
  { pattern: /^o1|^o3/i, family: 'openai-o', displayName: 'OpenAI o-series' },
  { pattern: /^claude/i, family: 'anthropic', displayName: 'Anthropic Claude' },
  { pattern: /^gemini/i, family: 'google', displayName: 'Google Gemini' },
  { pattern: /qwen|qwq/i, family: 'qwen', displayName: '通义千问 Qwen' },
  { pattern: /deepseek/i, family: 'deepseek', displayName: 'DeepSeek' },
  { pattern: /llama/i, family: 'meta', displayName: 'Meta Llama' },
  { pattern: /mistral|mixtral|codestral/i, family: 'mistral', displayName: 'Mistral AI' },
  { pattern: /glm|chatglm/i, family: 'zhipu', displayName: '智谱 GLM' },
  { pattern: /moonshot|kimi/i, family: 'moonshot', displayName: 'Moonshot' },
  { pattern: /yi-/i, family: 'yi', displayName: '零一万物 Yi' },
  { pattern: /gemma/i, family: 'gemma', displayName: 'Google Gemma' },
  { pattern: /phi-/i, family: 'phi', displayName: 'Microsoft Phi' },
  { pattern: /internlm|internvl/i, family: 'intern', displayName: 'InternLM' },
  { pattern: /bge|gte/i, family: 'embedding-cn', displayName: '中文 Embedding' },
  { pattern: /text-embedding|embed/i, family: 'embedding', displayName: 'Embedding 模型' },
  { pattern: /whisper|sensevoice/i, family: 'audio', displayName: '语音模型' },
  { pattern: /tts|speech/i, family: 'tts', displayName: '语音合成' },
  { pattern: /rerank/i, family: 'rerank', displayName: 'Rerank 模型' },
  {
    pattern: /flux|stable-diffusion|sd3|sdxl|dall-e/i,
    family: 'image-gen',
    displayName: '图像生成',
  },
];

function getModelFamily(modelId: string): { family: string; displayName: string } {
  for (const rule of MODEL_FAMILY_PATTERNS) {
    if (rule.pattern.test(modelId)) {
      return { family: rule.family, displayName: rule.displayName };
    }
  }
  return { family: 'other', displayName: 'Other Models' };
}

// ====== Type Configuration ======

const TYPE_CONFIG: Record<ModelType, { label: string; icon: typeof Bot; color: string }> = {
  chat: { label: 'Chat', icon: Bot, color: 'text-blue-400' },
  completion: { label: 'Completion', icon: Zap, color: 'text-yellow-400' },
  vision: { label: 'Vision', icon: Eye, color: 'text-purple-400' },
  embedding: { label: 'Embedding', icon: Sparkles, color: 'text-green-400' },
  rerank: { label: 'Rerank', icon: Filter, color: 'text-orange-400' },
  stt: { label: 'Speech Recognition', icon: Bot, color: 'text-red-400' },
  tts: { label: 'Speech Synthesis', icon: Bot, color: 'text-pink-400' },
};

// ====== Main Component ======

export const ModelPickerModal: React.FC<ModelPickerModalProps> = ({
  open,
  onClose,
  onAdd,
  baseUrl,
  apiKey,
  existingModelIds,
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiModels, setApiModels] = useState<APIModel[]>([]);
  const [searchText, setSearchText] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [typeFilter, setTypeFilter] = useState<ModelType | 'all'>('all');
  const [expandedFamilies, setExpandedFamilies] = useState<Set<string>>(new Set());

  // Fetch model list
  const fetchModels = useCallback(async () => {
    if (!baseUrl) {
      setError('API address is empty, please configure provider first');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await api.ai.fetchModels(baseUrl, apiKey);

      if (result.success && result.models) {
        setApiModels(result.models);
        // Expand first 5 groups by default
        const families = new Set<string>();
        result.models.slice(0, 20).forEach((m: APIModel) => {
          families.add(getModelFamily(m.id).family);
        });
        setExpandedFamilies(families);
      } else {
        setError(result.error || 'Failed to fetch model list');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch model list');
    } finally {
      setLoading(false);
    }
  }, [baseUrl, apiKey]);

  // Auto-fetch when opened
  useEffect(() => {
    if (open && apiModels.length === 0) {
      fetchModels();
    }
  }, [open, fetchModels, apiModels.length]);

  // Reset selection
  useEffect(() => {
    if (!open) {
      setSelectedIds(new Set());
      setSearchText('');
      setTypeFilter('all');
    }
  }, [open]);

  // Processed model list (add type and grouping info)
  const processedModels = useMemo(() => {
    return apiModels
      .filter((m) => !existingModelIds.includes(m.id)) // Exclude existing ones
      .map((m) => ({
        ...m,
        inferredType: inferModelType(m.id),
        family: getModelFamily(m.id),
      }));
  }, [apiModels, existingModelIds]);

  // Filtered models
  const filteredModels = useMemo(() => {
    let models = processedModels;

    // Search filter
    if (searchText) {
      const lower = searchText.toLowerCase();
      models = models.filter((m) => m.id.toLowerCase().includes(lower));
    }

    // Type filter - chat and completion are interchangeable
    if (typeFilter !== 'all') {
      if (typeFilter === 'chat' || typeFilter === 'completion') {
        // 🔧 Chat and completion are interchangeable: selecting one shows both types
        models = models.filter((m) => m.inferredType === 'chat' || m.inferredType === 'completion');
      } else {
        models = models.filter((m) => m.inferredType === typeFilter);
      }
    }

    return models;
  }, [processedModels, searchText, typeFilter]);

  // Group models by family
  const groupedModels = useMemo(() => {
    const groups: Record<string, { displayName: string; models: typeof filteredModels }> = {};

    filteredModels.forEach((model) => {
      const { family, displayName } = model.family;
      if (!groups[family]) {
        groups[family] = { displayName, models: [] };
      }
      groups[family].models.push(model);
    });

    // Sort by model count
    return Object.entries(groups).sort((a, b) => b[1].models.length - a[1].models.length);
  }, [filteredModels]);

  // Type statistics - chat and completion are interchangeable
  const typeStats = useMemo(() => {
    const stats: Record<string, number> = { all: processedModels.length };
    processedModels.forEach((m) => {
      stats[m.inferredType] = (stats[m.inferredType] || 0) + 1;
    });
    // 🔧 Chat and completion are interchangeable: chat models can also be used for completion
    const chatCount = stats['chat'] || 0;
    const completionCount = stats['completion'] || 0;
    stats['chat'] = chatCount + completionCount;
    stats['completion'] = chatCount + completionCount;
    return stats;
  }, [processedModels]);

  // Toggle selection
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // Toggle family expansion
  const toggleFamily = useCallback((family: string) => {
    setExpandedFamilies((prev) => {
      const next = new Set(prev);
      if (next.has(family)) {
        next.delete(family);
      } else {
        next.add(family);
      }
      return next;
    });
  }, []);

  // Select/deselect all in current group
  const toggleSelectFamily = useCallback(
    (models: typeof filteredModels) => {
      const familyIds = models.map((m) => m.id);
      const allSelected = familyIds.every((id) => selectedIds.has(id));

      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (allSelected) {
          familyIds.forEach((id) => next.delete(id));
        } else {
          familyIds.forEach((id) => next.add(id));
        }
        return next;
      });
    },
    [selectedIds]
  );

  // Add selected models
  const handleAdd = useCallback(() => {
    const modelsToAdd: ModelInfo[] = [];
    processedModels.forEach((m) => {
      if (selectedIds.has(m.id)) {
        modelsToAdd.push({
          id: m.id,
          name: m.id.split('/').pop() || m.id,
          type: m.inferredType,
        });
      }
    });
    onAdd(modelsToAdd);
    onClose();
  }, [processedModels, selectedIds, onAdd, onClose]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Fetch Models from API"
      size="full"
      className="!max-w-3xl"
      noBodyScroll
    >
      <div className="flex flex-col -mx-4 -mb-4" style={{ minHeight: '400px', maxHeight: '55vh' }}>
        {/* Top toolbar */}
        <div className="px-4 py-3 border-b border-[var(--color-border)] space-y-3">
          {/* Search and refresh */}
          <div className="flex gap-2">
            <Input
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Search model name..."
              leftIcon={<Search size={14} />}
              className="flex-1"
            />
            <Button variant="secondary" onClick={fetchModels} disabled={loading}>
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </Button>
          </div>

          {/* Type filter */}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setTypeFilter('all')}
              className={`px-3 py-1 text-xs rounded-full transition-colors cursor-pointer
                ${typeFilter === 'all' ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'}`}
            >
              All ({typeStats.all || 0})
            </button>
            {Object.entries(TYPE_CONFIG).map(([type, config]) => {
              const count = typeStats[type] || 0;
              if (count === 0) return null;
              return (
                <button
                  key={type}
                  onClick={() => setTypeFilter(type as ModelType)}
                  className={`px-3 py-1 text-xs rounded-full transition-colors cursor-pointer flex items-center gap-1
                    ${typeFilter === type ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'}`}
                >
                  <config.icon size={10} />
                  {config.label} ({count})
                </button>
              );
            })}
          </div>
        </div>

        {/* Model list */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-[var(--color-text-muted)]">
              <Loader2 size={24} className="animate-spin mr-3" />
              Fetching model list...
            </div>
          ) : error ? (
            <div className="text-center py-12">
              <p className="text-[var(--color-error)] mb-4">{error}</p>
              <Button variant="secondary" onClick={fetchModels}>
                Retry
              </Button>
            </div>
          ) : groupedModels.length === 0 ? (
            <div className="text-center py-12 text-[var(--color-text-muted)]">
              {searchText ? 'No matching models found' : 'No available models'}
            </div>
          ) : (
            <div className="space-y-2">
              {groupedModels.map(([family, { displayName, models }]) => {
                const isExpanded = expandedFamilies.has(family);
                const selectedCount = models.filter((m) => selectedIds.has(m.id)).length;
                const allSelected = models.length > 0 && selectedCount === models.length;

                return (
                  <div
                    key={family}
                    className="border border-[var(--color-border)] rounded-lg overflow-hidden"
                  >
                    {/* Group header */}
                    <div
                      className="flex items-center gap-3 px-4 py-3 bg-[var(--color-bg-tertiary)] cursor-pointer hover:bg-[var(--color-bg-hover)] transition-colors"
                      onClick={() => toggleFamily(family)}
                    >
                      {isExpanded ? (
                        <ChevronDown size={16} className="text-[var(--color-text-muted)]" />
                      ) : (
                        <ChevronRight size={16} className="text-[var(--color-text-muted)]" />
                      )}
                      <span className="font-medium text-[var(--color-text-primary)] flex-1">
                        {displayName}
                      </span>
                      <Badge variant="secondary" size="sm">
                        {models.length}
                      </Badge>
                      {selectedCount > 0 && (
                        <Badge variant="success" size="sm">
                          Selected {selectedCount}
                        </Badge>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleSelectFamily(models);
                        }}
                        className={`px-2 py-1 text-xs rounded transition-colors cursor-pointer
                          ${allSelected ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'}`}
                      >
                        {allSelected ? 'Deselect All' : 'Select All'}
                      </button>
                    </div>

                    {/* Model list */}
                    {isExpanded && (
                      <div className="p-2 grid grid-cols-1 sm:grid-cols-2 gap-2 bg-[var(--color-bg-secondary)]">
                        {models.map((model) => {
                          const isSelected = selectedIds.has(model.id);
                          const typeConfig = TYPE_CONFIG[model.inferredType];

                          return (
                            <div
                              key={model.id}
                              onClick={() => toggleSelect(model.id)}
                              className={`p-3 rounded-lg border cursor-pointer transition-all
                                ${isSelected ? 'bg-[var(--color-accent-muted)] border-[var(--color-accent)]' : 'bg-[var(--color-bg-tertiary)] border-[var(--color-border)] hover:border-[var(--color-border-strong)]'}`}
                            >
                              <div className="flex items-start gap-2">
                                <div
                                  className={`w-4 h-4 rounded border flex-shrink-0 mt-0.5 flex items-center justify-center
                                    ${isSelected ? 'bg-[var(--color-accent)] border-[var(--color-accent)]' : 'border-[var(--color-border-strong)]'}`}
                                >
                                  {isSelected && <Check size={10} className="text-white" />}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="font-medium text-sm text-[var(--color-text-primary)] truncate">
                                    {model.id.split('/').pop() || model.id}
                                  </div>
                                  <div className="text-xs text-[var(--color-text-muted)] truncate font-mono">
                                    {model.id}
                                  </div>
                                </div>
                                <div
                                  className={`text-xs ${typeConfig.color} flex items-center gap-1`}
                                >
                                  <typeConfig.icon size={10} />
                                  {typeConfig.label}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Bottom action bar */}
        <div className="px-4 py-3 border-t border-[var(--color-border)] bg-[var(--color-bg-primary)] flex items-center justify-between">
          <div className="text-sm text-[var(--color-text-muted)]">
            {selectedIds.size > 0 ? (
              <span>
                Selected{' '}
                <span className="text-[var(--color-accent)] font-medium">{selectedIds.size}</span>{' '}
                model{selectedIds.size > 1 ? 's' : ''}
              </span>
            ) : (
              <span>Click model cards to select</span>
            )}
          </div>
          <div className="flex gap-3">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={selectedIds.size === 0} onClick={handleAdd}>
              Add {selectedIds.size > 0 && `(${selectedIds.size})`}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
};
