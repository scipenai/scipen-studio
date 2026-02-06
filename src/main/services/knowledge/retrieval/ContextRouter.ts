/**
 * @file ContextRouter - Semantic Router
 * @description Intelligently determines required context type for queries (full document/partial chunks/no retrieval)
 * @depends LoggerService
 */

import { createLogger } from '../../LoggerService';

const logger = createLogger('ContextRouter');

export type ContextType = 'full' | 'partial' | 'none';

export interface ContextDecision {
  contextType: ContextType;
  reason: string;
  suggestedChunkCount: number;
  needsMultiDocument: boolean;
  /** Decision confidence score (0-1) */
  confidence: number;
}

export interface ContextRouterConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  enabled?: boolean;
}

export class ContextRouter {
  private config: ContextRouterConfig;

  // ====== Pattern Rules ======

  /** Patterns indicating full document context needed */
  private readonly FULL_CONTEXT_PATTERNS = [
    /整体|全文|总结|概述|大纲|框架|结构/,
    /overall|entire|whole|summary|outline|structure|overview/i,
    /比较|对比|区别|联系|关系|差异/,
    /compare|contrast|difference|relation|connection|versus/i,
    /流程|步骤|过程|方法论|架构/,
    /process|procedure|steps|methodology|architecture|workflow/i,
    /主要内容|核心思想|贡献|创新点/,
    /main contribution|key idea|innovation|novelty/i,
  ];

  /** Patterns indicating partial context (specific chunks) needed */
  private readonly PARTIAL_CONTEXT_PATTERNS = [
    /什么是|定义|解释|说明|含义/,
    /what is|define|explain|describe|meaning/i,
    /怎么|如何|方法|技术|实现/,
    /how to|method|technique|approach|implement/i,
    /哪个|哪些|列举|举例|有哪些/,
    /which|list|example|enumerate|what are/i,
    /具体|细节|参数|数值|公式/,
    /specific|detail|parameter|value|formula/i,
  ];

  /** Patterns indicating no retrieval needed (greetings, creative tasks) */
  // Note: Use word boundaries \b to avoid matching substrings (e.g., "hi" in "which")
  private readonly NO_CONTEXT_PATTERNS = [
    /你好|谢谢|再见|早上好|晚上好/,
    /\b(hello|hi|thanks?|bye|good morning|good night)\b/i,
    /帮我写|生成|创作|编写代码/,
    /\b(write|generate|create|compose)\b/i,
    /翻译|转换|格式化/,
    /\b(translate|convert|format)\b/i,
  ];

  constructor(config: ContextRouterConfig) {
    // Filter undefined values to avoid overwriting defaults
    const filteredConfig = Object.fromEntries(
      Object.entries(config).filter(([, v]) => v !== undefined)
    ) as Partial<ContextRouterConfig>;

    // Auto-select default model based on baseUrl
    const baseUrl = config.baseUrl || 'https://api.openai.com/v1';
    let defaultModel = 'qwen-turbo';
    if (baseUrl.includes('api.openai.com')) {
      defaultModel = 'gpt-4o-mini';
    } else if (baseUrl.includes('api.anthropic.com')) {
      defaultModel = 'claude-3-haiku-20240307';
    } else if (baseUrl.includes('dashscope.aliyuncs.com')) {
      defaultModel = 'qwen-turbo';
    }

    this.config = {
      apiKey: config.apiKey,
      baseUrl: baseUrl,
      model: defaultModel,
      enabled: true,
      ...filteredConfig,
    };
  }

  updateConfig(config: Partial<ContextRouterConfig>): void {
    if (config.apiKey !== undefined) this.config.apiKey = config.apiKey;
    if (config.baseUrl !== undefined) this.config.baseUrl = config.baseUrl;
    if (config.model !== undefined) this.config.model = config.model;
    if (config.enabled !== undefined) this.config.enabled = config.enabled;
  }

  getConfig(): ContextRouterConfig {
    return { ...this.config };
  }

  /**
   * Determine required context type for a query.
   *
   * Uses fast rule-based matching first; falls back to LLM for ambiguous cases.
   */
  async route(query: string): Promise<ContextDecision> {
    logger.info('[ContextRouter] Starting semantic routing...');
    logger.info('[ContextRouter] Query:', `${query.slice(0, 50)}...`);

    const ruleBasedDecision = this.ruleBasedRoute(query);

    // High-confidence rule match: skip LLM
    if (ruleBasedDecision.confidence >= 0.8) {
      logger.info(
        `[ContextRouter] Rule match: ${ruleBasedDecision.contextType}, confidence: ${ruleBasedDecision.confidence}`
      );
      return ruleBasedDecision;
    }

    // Use LLM for more precise routing if available
    if (this.config.enabled && this.config.apiKey) {
      try {
        const llmDecision = await this.llmRoute(query);
        logger.info(
          `[ContextRouter] LLM routing: ${llmDecision.contextType}, reason: ${llmDecision.reason}`
        );
        return llmDecision;
      } catch (error) {
        console.error('[ContextRouter] LLM routing failed, using rule-based:', error);
      }
    }

    logger.info('[ContextRouter] Using rule-based routing:', ruleBasedDecision.contextType);
    return ruleBasedDecision;
  }

  private ruleBasedRoute(query: string): ContextDecision {
    for (const pattern of this.NO_CONTEXT_PATTERNS) {
      if (pattern.test(query)) {
        return {
          contextType: 'none',
          reason: 'Query does not require retrieval context',
          suggestedChunkCount: 0,
          needsMultiDocument: false,
          confidence: 0.9,
        };
      }
    }

    for (const pattern of this.FULL_CONTEXT_PATTERNS) {
      if (pattern.test(query)) {
        return {
          contextType: 'full',
          reason: 'Requires understanding full document structure or comparison',
          suggestedChunkCount: 10,
          needsMultiDocument: true,
          confidence: 0.85,
        };
      }
    }

    for (const pattern of this.PARTIAL_CONTEXT_PATTERNS) {
      if (pattern.test(query)) {
        return {
          contextType: 'partial',
          reason: 'Requires specific chunks to answer concrete question',
          suggestedChunkCount: 5,
          needsMultiDocument: false,
          confidence: 0.8,
        };
      }
    }

    // Low confidence default - LLM should refine this
    return {
      contextType: 'partial',
      reason: 'Default retrieval of relevant chunks',
      suggestedChunkCount: 5,
      needsMultiDocument: false,
      confidence: 0.5,
    };
  }

  private async llmRoute(query: string): Promise<ContextDecision> {
    const systemPrompt = `You are a query analyzer for a RAG (Retrieval-Augmented Generation) system.
Analyze the user query and determine what type of context is needed.

Context types:
- "full": Need complete document context (for: understanding document structure, comparing multiple documents, analyzing methodology, summarizing entire text)
- "partial": Need specific relevant chunks (for: answering specific questions, finding facts, explaining concepts)
- "none": No retrieval needed (for: greetings, creative writing, general knowledge)

Respond in JSON format:
{
  "contextType": "full" | "partial" | "none",
  "reason": "brief explanation",
  "suggestedChunkCount": number (1-10),
  "needsMultiDocument": boolean
}`;

    let apiUrl = this.config.baseUrl || 'https://api.openai.com/v1';
    if (!apiUrl.endsWith('/chat/completions')) {
      if (apiUrl.endsWith('/')) {
        apiUrl = apiUrl.slice(0, -1);
      }
      apiUrl = `${apiUrl}/chat/completions`;
    }

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Query: "${query}"` },
        ],
        temperature: 0,
        max_tokens: 200,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Context routing API error: ${response.status} - ${errorText}`);
    }

    interface LLMResponse {
      choices?: Array<{
        message?: {
          content?: string;
        };
      }>;
    }
    const data = (await response.json()) as LLMResponse;
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error('Empty response from router');
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('Cannot parse router response as JSON');
      }
    }

    return {
      contextType: parsed.contextType || 'partial',
      reason: parsed.reason || '',
      suggestedChunkCount: parsed.suggestedChunkCount || 5,
      needsMultiDocument: parsed.needsMultiDocument || false,
      confidence: 0.9,
    };
  }

  /** Convert routing decision to retrieval parameters */
  getRetrievalParams(decision: ContextDecision): {
    topK: number;
    includeAdjacent: boolean;
    diversify: boolean;
  } {
    switch (decision.contextType) {
      case 'full':
        return {
          topK: decision.suggestedChunkCount,
          includeAdjacent: true,
          diversify: decision.needsMultiDocument,
        };
      case 'partial':
        return {
          topK: decision.suggestedChunkCount,
          includeAdjacent: false,
          diversify: false,
        };
      default:
        return {
          topK: 0,
          includeAdjacent: false,
          diversify: false,
        };
    }
  }
}
