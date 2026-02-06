/**
 * @file ContextRouter.test.ts - Unit tests for RAG semantic router
 * @description Tests rule-based routing, configuration management, LLM routing (mocked), and retrieval parameter generation
 * @depends ContextRouter
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ====== Mock fetch for LLM calls ======

const mockFetch = vi.fn();

// ====== Import after mocks ======

import {
  type ContextDecision,
  ContextRouter,
  type ContextRouterConfig,
} from '../../../src/main/services/knowledge/retrieval/ContextRouter';

describe('ContextRouter', () => {
  let router: ContextRouter;
  const defaultConfig: ContextRouterConfig = {
    apiKey: 'test-api-key',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    enabled: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);

    router = new ContextRouter(defaultConfig);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ====== Configuration ======

  describe('Configuration', () => {
    it('should initialize with provided config', () => {
      const config = router.getConfig();

      expect(config.apiKey).toBe(defaultConfig.apiKey);
      expect(config.baseUrl).toBe(defaultConfig.baseUrl);
      expect(config.model).toBe(defaultConfig.model);
      expect(config.enabled).toBe(true);
    });

    it('should use default baseUrl when not provided', () => {
      const r = new ContextRouter({ apiKey: 'key' });
      const config = r.getConfig();

      expect(config.baseUrl).toBe('https://api.openai.com/v1');
    });

    it('should auto-select model based on baseUrl - OpenAI', () => {
      const r = new ContextRouter({
        apiKey: 'key',
        baseUrl: 'https://api.openai.com/v1',
      });

      expect(r.getConfig().model).toBe('gpt-4o-mini');
    });

    it('should auto-select model based on baseUrl - Anthropic', () => {
      const r = new ContextRouter({
        apiKey: 'key',
        baseUrl: 'https://api.anthropic.com/v1',
      });

      expect(r.getConfig().model).toBe('claude-3-haiku-20240307');
    });

    it('should auto-select model based on baseUrl - Dashscope', () => {
      const r = new ContextRouter({
        apiKey: 'key',
        baseUrl: 'https://dashscope.aliyuncs.com/v1',
      });

      expect(r.getConfig().model).toBe('qwen-turbo');
    });

    it('should update config correctly', () => {
      router.updateConfig({ model: 'new-model', enabled: false });
      const config = router.getConfig();

      expect(config.model).toBe('new-model');
      expect(config.enabled).toBe(false);
      expect(config.apiKey).toBe(defaultConfig.apiKey); // Unchanged
    });

    it('should not update with undefined values', () => {
      router.updateConfig({ model: undefined });
      const config = router.getConfig();

      expect(config.model).toBe('gpt-4o-mini'); // Still original
    });
  });

  // ====== Rule-Based Routing ======

  describe('Rule-Based Routing', () => {
    beforeEach(() => {
      router.updateConfig({ enabled: false });
    });

    describe('No Context Needed', () => {
      const noContextQueries = [
        '你好',
        'Hello',
        'Hi there',
        '谢谢',
        'Thank you',
        '帮我写一首诗',
        'Write me a poem',
        'Generate some code',
        '帮我翻译这段话',
        'Translate this text',
      ];

      it.each(noContextQueries)('should return "none" for: "%s"', async (query) => {
        const decision = await router.route(query);

        expect(decision.contextType).toBe('none');
        expect(decision.suggestedChunkCount).toBe(0);
        expect(decision.confidence).toBeGreaterThanOrEqual(0.8);
      });
    });

    describe('Full Context Needed', () => {
      const fullContextQueries = [
        '总结这篇论文的整体内容',
        'Summarize the entire paper',
        '这篇论文的框架结构是什么',
        'What is the overall structure',
        '比较这两篇论文的区别',
        'Compare the differences between',
        '这篇论文的主要贡献是什么',
        'What is the main contribution',
        '介绍一下这个方法论',
        'Explain the methodology',
      ];

      it.each(fullContextQueries)('should return "full" for: "%s"', async (query) => {
        const decision = await router.route(query);

        expect(decision.contextType).toBe('full');
        expect(decision.suggestedChunkCount).toBeGreaterThan(5);
        expect(decision.needsMultiDocument).toBe(true);
        expect(decision.confidence).toBeGreaterThanOrEqual(0.8);
      });
    });

    describe('Partial Context Needed', () => {
      const partialContextQueries = [
        '什么是深度学习',
        'What is deep learning',
        '如何实现注意力机制',
        'How to implement attention',
        '论文中用了哪些数据集',
        'Which datasets are used',
        '具体的参数设置是什么',
        'What are the specific parameters',
        '解释一下这个公式',
        'Explain this formula',
      ];

      it.each(partialContextQueries)('should return "partial" for: "%s"', async (query) => {
        const decision = await router.route(query);

        expect(decision.contextType).toBe('partial');
        expect(decision.suggestedChunkCount).toBeGreaterThan(0);
        expect(decision.confidence).toBeGreaterThanOrEqual(0.8);
      });
    });

    describe('Default Behavior', () => {
      it('should return partial with low confidence for ambiguous queries', async () => {
        const ambiguousQuery = 'Tell me something interesting';
        const decision = await router.route(ambiguousQuery);

        expect(decision.contextType).toBe('partial');
        expect(decision.confidence).toBeLessThan(0.8);
      });
    });
  });

  // ====== LLM Routing ======

  describe('LLM Routing', () => {
    beforeEach(() => {
      router.updateConfig({ enabled: true });
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    contextType: 'full',
                    reason: 'Query requires understanding the complete document',
                    suggestedChunkCount: 8,
                    needsMultiDocument: true,
                  }),
                },
              },
            ],
          }),
      });
    });

    it('should use LLM for low-confidence rule decisions', async () => {
      const ambiguousQuery = 'Tell me more about the paper';
      await router.route(ambiguousQuery);

      expect(mockFetch).toHaveBeenCalled();
    });

    it('should skip LLM for high-confidence rule decisions', async () => {
      const clearQuery = '你好';
      await router.route(clearQuery);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should parse LLM response correctly', async () => {
      const query = 'xyz abc 123';
      const decision = await router.route(query);

      expect(decision.contextType).toBe('full');
      expect(decision.suggestedChunkCount).toBe(8);
      expect(decision.needsMultiDocument).toBe(true);
    });

    it('should fallback to rule-based on LLM error', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const query = 'Some query';
      const decision = await router.route(query);

      expect(decision.contextType).toBeDefined();
    });

    it('should handle API error response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      const query = 'Some query';
      const decision = await router.route(query);

      expect(decision.contextType).toBeDefined();
    });

    it('should handle malformed JSON response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: 'This is not JSON',
                },
              },
            ],
          }),
      });

      const query = 'Some query';
      const decision = await router.route(query);

      expect(decision.contextType).toBeDefined();
    });

    it('should extract JSON from mixed response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content:
                    'Here is my analysis: {"contextType": "partial", "reason": "test", "suggestedChunkCount": 3, "needsMultiDocument": false}',
                },
              },
            ],
          }),
      });

      const query = 'Some query';
      const decision = await router.route(query);

      expect(decision.contextType).toBe('partial');
      expect(decision.suggestedChunkCount).toBe(3);
    });

    it('should skip LLM when disabled', async () => {
      router.updateConfig({ enabled: false });

      const query = 'Some ambiguous query';
      await router.route(query);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should skip LLM when no API key', async () => {
      router.updateConfig({ apiKey: '' });

      const query = 'Some ambiguous query';
      await router.route(query);

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ====== Retrieval Parameters ======

  describe('getRetrievalParams', () => {
    it('should return correct params for "full" context', () => {
      const decision: ContextDecision = {
        contextType: 'full',
        reason: 'test',
        suggestedChunkCount: 10,
        needsMultiDocument: true,
        confidence: 0.9,
      };

      const params = router.getRetrievalParams(decision);

      expect(params.topK).toBe(10);
      expect(params.includeAdjacent).toBe(true);
      expect(params.diversify).toBe(true);
    });

    it('should return correct params for "partial" context', () => {
      const decision: ContextDecision = {
        contextType: 'partial',
        reason: 'test',
        suggestedChunkCount: 5,
        needsMultiDocument: false,
        confidence: 0.8,
      };

      const params = router.getRetrievalParams(decision);

      expect(params.topK).toBe(5);
      expect(params.includeAdjacent).toBe(false);
      expect(params.diversify).toBe(false);
    });

    it('should return correct params for "none" context', () => {
      const decision: ContextDecision = {
        contextType: 'none',
        reason: 'test',
        suggestedChunkCount: 0,
        needsMultiDocument: false,
        confidence: 0.9,
      };

      const params = router.getRetrievalParams(decision);

      expect(params.topK).toBe(0);
      expect(params.includeAdjacent).toBe(false);
      expect(params.diversify).toBe(false);
    });

    it('should use needsMultiDocument for diversify in full context', () => {
      const decisionWithMultiDoc: ContextDecision = {
        contextType: 'full',
        reason: 'test',
        suggestedChunkCount: 8,
        needsMultiDocument: true,
        confidence: 0.9,
      };

      const decisionWithoutMultiDoc: ContextDecision = {
        contextType: 'full',
        reason: 'test',
        suggestedChunkCount: 8,
        needsMultiDocument: false,
        confidence: 0.9,
      };

      const paramsMulti = router.getRetrievalParams(decisionWithMultiDoc);
      const paramsSingle = router.getRetrievalParams(decisionWithoutMultiDoc);

      expect(paramsMulti.diversify).toBe(true);
      expect(paramsSingle.diversify).toBe(false);
    });
  });

  // ====== Edge Cases ======

  describe('Edge Cases', () => {
    beforeEach(() => {
      router.updateConfig({ enabled: false });
    });

    it('should handle empty query', async () => {
      const decision = await router.route('');

      expect(decision.contextType).toBeDefined();
    });

    it('should handle very long query', async () => {
      const longQuery = `${'What is '.repeat(1000)}machine learning?`;
      const decision = await router.route(longQuery);

      expect(decision.contextType).toBeDefined();
    });

    it('should handle mixed language query', async () => {
      const mixedQuery = '请explain what is深度学习';
      const decision = await router.route(mixedQuery);

      expect(decision.contextType).toBe('partial');
    });

    it('should handle special characters', async () => {
      const specialQuery = 'What is @#$%^&*() in the paper?';
      const decision = await router.route(specialQuery);

      expect(decision.contextType).toBeDefined();
    });

    it('should prioritize no-context patterns', async () => {
      const query = '你好，请解释什么是机器学习';
      const decision = await router.route(query);

      expect(decision.contextType).toBe('none');
    });

    it('should return decision with all required fields', async () => {
      const decision = await router.route('Any query');

      expect(decision).toHaveProperty('contextType');
      expect(decision).toHaveProperty('reason');
      expect(decision).toHaveProperty('suggestedChunkCount');
      expect(decision).toHaveProperty('needsMultiDocument');
      expect(decision).toHaveProperty('confidence');
    });
  });
});
