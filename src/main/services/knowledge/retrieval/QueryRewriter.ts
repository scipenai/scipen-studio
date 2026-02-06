/**
 * @file QueryRewriter - Intelligent Query Rewriter
 * @description Performs coreference resolution, context completion, bilingual translation and keyword extraction based on chat history
 * @depends LoggerService
 */

export interface RewrittenQuery {
  original: string;
  english: string;
  chinese: string;
  keywords: string[];
  originalLanguage: 'en' | 'zh' | 'mixed';
}

import { createLogger } from '../../LoggerService';

const logger = createLogger('QueryRewriter');

export interface QueryRewriterConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  enabled?: boolean;
}

export class QueryRewriter {
  private config: QueryRewriterConfig;

  constructor(config: QueryRewriterConfig) {
    const filteredConfig = Object.fromEntries(
      Object.entries(config).filter(([, v]) => v !== undefined)
    );

    const baseUrl = config.baseUrl || 'https://api.openai.com/v1';
    const model = config.model;

    this.config = {
      apiKey: config.apiKey,
      baseUrl: baseUrl,
      model: model,
      enabled: true,
      ...filteredConfig,
    };

    logger.info('[QueryRewriter] Initialized:', {
      hasApiKey: !!this.config.apiKey,
      baseUrl: this.config.baseUrl,
      model: this.config.model,
      enabled: this.config.enabled,
    });
  }

  updateConfig(config: Partial<QueryRewriterConfig>): void {
    if (config.apiKey !== undefined) this.config.apiKey = config.apiKey;
    if (config.baseUrl !== undefined) this.config.baseUrl = config.baseUrl;
    if (config.model !== undefined) this.config.model = config.model;
    if (config.enabled !== undefined) this.config.enabled = config.enabled;
  }

  getConfig(): QueryRewriterConfig {
    return { ...this.config };
  }

  /**
   * Rewrite query based on conversation history.
   * Generates standalone, bilingual query with keywords.
   */
  async rewrite(
    query: string,
    history: Array<{ role: string; content: string }> = []
  ): Promise<RewrittenQuery> {
    logger.info('[QueryRewriter] Starting query rewrite...');
    logger.info('[QueryRewriter] Original:', `${query.slice(0, 50)}...`);
    logger.info('[QueryRewriter] History messages:', history.length);

    if (!this.config.enabled || !this.config.apiKey) {
      logger.info('[QueryRewriter] Disabled or no API key, using simple rewrite');
      return this.createSimpleQuery(query);
    }

    try {
      const response = await this.callLLM(query, history);
      logger.info('[QueryRewriter] ✓ Query rewrite complete');
      logger.info('[QueryRewriter] Result:', {
        original: response.original.slice(0, 50),
        keywords: response.keywords,
      });
      return response;
    } catch (error) {
      console.error('[QueryRewriter] Query rewrite failed:', error);
      return this.createSimpleQuery(query);
    }
  }

  private async callLLM(
    query: string,
    history: Array<{ role: string; content: string }>
  ): Promise<RewrittenQuery> {
    const systemPrompt = `You are an academic research query rewriting assistant. Your tasks are:
1. Understand user intent from conversation history
2. Generate complete, standalone queries that can be understood without context
3. Translate queries into both English and Chinese
4. Extract search keywords

Rules:
- Rewritten queries should be self-contained and understandable without conversation history
- Replace pronouns (it, this, that, 它, 这个, 那个) with specific nouns
- Fill in omitted information from context
- Keep queries concise (no more than 50 words)
- Extract 3-5 keywords

Respond in JSON format:
{
  "original": "rewritten query in original language",
  "english": "English version",
  "chinese": "Chinese version",
  "keywords": ["keyword1", "keyword2", "keyword3"],
  "originalLanguage": "en" | "zh" | "mixed"
}`;

    // Keep only recent history to avoid context length issues
    const recentHistory = history.slice(-4);
    const messages = [
      { role: 'system', content: systemPrompt },
      ...recentHistory,
      { role: 'user', content: `Please rewrite this query: "${query}"` },
    ];

    let apiUrl = this.config.baseUrl || 'https://api.openai.com/v1';
    if (!apiUrl.endsWith('/chat/completions')) {
      if (apiUrl.endsWith('/')) {
        apiUrl = apiUrl.slice(0, -1);
      }
      apiUrl = `${apiUrl}/chat/completions`;
    }

    logger.info('[QueryRewriter] Calling LLM:', this.config.model);

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        temperature: 0,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API error: ${response.status} - ${errorText}`);
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
      throw new Error('Empty response from LLM');
    }

    let parsed: {
      original?: string;
      english?: string;
      chinese?: string;
      keywords?: string[];
      originalLanguage?: 'en' | 'zh' | 'mixed';
    };
    try {
      parsed = JSON.parse(content);
    } catch {
      // Try extracting from markdown code block
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[1]);
      } else {
        const objectMatch = content.match(/\{[\s\S]*\}/);
        if (objectMatch) {
          parsed = JSON.parse(objectMatch[0]);
        } else {
          throw new Error('Cannot parse LLM response as JSON');
        }
      }
    }

    return {
      original: parsed.original || query,
      english: parsed.english || query,
      chinese: parsed.chinese || query,
      keywords: parsed.keywords || this.extractKeywords(query),
      originalLanguage: parsed.originalLanguage || this.detectLanguage(query),
    };
  }

  private createSimpleQuery(query: string): RewrittenQuery {
    return {
      original: query,
      english: query,
      chinese: query,
      keywords: this.extractKeywords(query),
      originalLanguage: this.detectLanguage(query),
    };
  }

  private extractKeywords(text: string): string[] {
    const stopWords = new Set([
      'the',
      'a',
      'an',
      'is',
      'are',
      'was',
      'were',
      'be',
      'been',
      'have',
      'has',
      'had',
      'do',
      'does',
      'did',
      'will',
      'would',
      'could',
      'should',
      'may',
      'might',
      'must',
      'shall',
      'can',
      'to',
      'of',
      'in',
      'for',
      'on',
      'with',
      'at',
      'by',
      'from',
      'as',
      'into',
      'through',
      'during',
      'before',
      'after',
      'what',
      'how',
      'why',
      'when',
      'where',
      'which',
      'who',
      '的',
      '了',
      '和',
      '是',
      '在',
      '有',
      '我',
      '他',
      '她',
      '它',
      '这',
      '那',
      '什么',
      '怎么',
      '如何',
      '为什么',
      '哪个',
      '哪些',
    ]);

    const words = text
      .toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fa5]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 1 && !stopWords.has(word));

    const wordCount = new Map<string, number>();
    for (const word of words) {
      wordCount.set(word, (wordCount.get(word) || 0) + 1);
    }

    return Array.from(wordCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);
  }

  private detectLanguage(text: string): 'en' | 'zh' | 'mixed' {
    const chineseChars = text.match(/[\u4e00-\u9fa5]/g)?.length || 0;
    const englishChars = text.match(/[a-zA-Z]/g)?.length || 0;
    const total = chineseChars + englishChars;

    if (total === 0) return 'en';
    if (chineseChars / total > 0.7) return 'zh';
    if (englishChars / total > 0.7) return 'en';
    return 'mixed';
  }
}
