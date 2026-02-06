/**
 * @file QueryRewriter.test.ts - Unit tests for intelligent query rewriter
 * @description Tests query rewriting (coreference resolution, context completion), bilingual translation, keyword extraction, language detection, LLM calls (mocked), and fallback to simple rewriting
 * @depends QueryRewriter
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ====== Mock fetch for LLM calls ======

const mockFetch = vi.fn();

// ====== Import after mocks ======

import { QueryRewriter } from '../../../src/main/services/knowledge/retrieval/QueryRewriter';

describe('QueryRewriter', () => {
  let rewriter: QueryRewriter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);

    rewriter = new QueryRewriter({
      apiKey: 'test-api-key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      enabled: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  // ====== Configuration ======

  describe('Configuration', () => {
    it('should initialize with provided config', () => {
      const config = rewriter.getConfig();

      expect(config.apiKey).toBe('test-api-key');
      expect(config.baseUrl).toBe('https://api.openai.com/v1');
      expect(config.model).toBe('gpt-4o-mini');
      expect(config.enabled).toBe(true);
    });

    it('should use default baseUrl when not provided', () => {
      const r = new QueryRewriter({ apiKey: 'key' });
      const config = r.getConfig();

      expect(config.baseUrl).toBe('https://api.openai.com/v1');
    });

    it('should update config', () => {
      rewriter.updateConfig({ model: 'gpt-4' });

      const config = rewriter.getConfig();
      expect(config.model).toBe('gpt-4');
      expect(config.apiKey).toBe('test-api-key'); // unchanged
    });

    it('should not update undefined values', () => {
      const originalConfig = rewriter.getConfig();
      rewriter.updateConfig({ model: undefined });

      expect(rewriter.getConfig().model).toBe(originalConfig.model);
    });
  });

  // ====== Simple Query (No LLM) ======

  describe('Simple Query Rewrite (No LLM)', () => {
    it('should return simple query when disabled', async () => {
      rewriter.updateConfig({ enabled: false });

      const result = await rewriter.rewrite('What is machine learning?');

      expect(result.original).toBe('What is machine learning?');
      expect(result.english).toBe('What is machine learning?');
      expect(result.chinese).toBe('What is machine learning?');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should return simple query when no API key', async () => {
      rewriter.updateConfig({ apiKey: '' });

      const result = await rewriter.rewrite('Test query');

      expect(result.original).toBe('Test query');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should extract keywords in simple mode', async () => {
      rewriter.updateConfig({ enabled: false });

      const result = await rewriter.rewrite('neural network deep learning AI');

      expect(result.keywords).toBeDefined();
      expect(result.keywords.length).toBeGreaterThan(0);
    });
  });

  // ====== LLM Query Rewrite ======

  describe('LLM Query Rewrite', () => {
    it('should call LLM API for rewriting', async () => {
      const mockResponse = {
        original: 'What is ML?',
        english: 'What is machine learning?',
        chinese: '什么是机器学习？',
        keywords: ['machine learning', 'ML', 'AI'],
        originalLanguage: 'en',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: JSON.stringify(mockResponse) } }],
          }),
      });

      const result = await rewriter.rewrite('What is ML?');

      expect(mockFetch).toHaveBeenCalled();
      expect(result.english).toBe('What is machine learning?');
      expect(result.chinese).toBe('什么是机器学习？');
    });

    it('should include conversation history in prompt', async () => {
      const mockResponse = {
        original: 'How does it work?',
        english: 'How does the transformer architecture work?',
        chinese: '变换器架构是如何工作的？',
        keywords: ['transformer', 'architecture', 'attention'],
        originalLanguage: 'en',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: JSON.stringify(mockResponse) } }],
          }),
      });

      const history = [
        { role: 'user', content: 'Tell me about transformers' },
        { role: 'assistant', content: 'Transformers are neural network architectures...' },
      ];

      await rewriter.rewrite('How does it work?', history);

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.messages.length).toBeGreaterThan(2);
    });

    it('should only use last 4 history messages', async () => {
      const mockResponse = {
        original: 'test',
        english: 'test',
        chinese: 'test',
        keywords: ['test'],
        originalLanguage: 'en',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: JSON.stringify(mockResponse) } }],
          }),
      });

      const longHistory = Array.from({ length: 10 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}`,
      }));

      await rewriter.rewrite('Test', longHistory);

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.messages.length).toBeLessThanOrEqual(6);
    });
  });

  // ====== Error Handling ======

  describe('Error Handling', () => {
    it('should fallback to simple query on API error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await rewriter.rewrite('Test query');

      expect(result.original).toBe('Test query');
      expect(result.english).toBe('Test query');
    });

    it('should fallback on non-OK response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      const result = await rewriter.rewrite('Test query');

      expect(result.original).toBe('Test query');
    });

    it('should fallback on empty response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: '' } }],
          }),
      });

      const result = await rewriter.rewrite('Test query');

      expect(result.original).toBe('Test query');
    });

    it('should handle JSON in markdown code block', async () => {
      const jsonContent = JSON.stringify({
        original: 'test',
        english: 'test in english',
        chinese: '中文测试',
        keywords: ['test'],
        originalLanguage: 'en',
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: `\`\`\`json\n${jsonContent}\n\`\`\`` } }],
          }),
      });

      const result = await rewriter.rewrite('test');

      expect(result.english).toBe('test in english');
    });

    it('should extract JSON object from response', async () => {
      const jsonContent = JSON.stringify({
        original: 'extracted',
        english: 'extracted query',
        chinese: '提取的查询',
        keywords: ['extract'],
        originalLanguage: 'en',
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: `Here is the result: ${jsonContent} end` } }],
          }),
      });

      const result = await rewriter.rewrite('extracted');

      expect(result.english).toBe('extracted query');
    });
  });

  // ====== Keyword Extraction ======

  describe('Keyword Extraction', () => {
    it('should extract English keywords', async () => {
      rewriter.updateConfig({ enabled: false });

      const result = await rewriter.rewrite(
        'The neural network uses deep learning for image classification'
      );

      expect(result.keywords).toContain('neural');
      expect(result.keywords).toContain('network');
      expect(result.keywords).toContain('deep');
      expect(result.keywords).toContain('learning');
    });

    it('should filter stop words', async () => {
      rewriter.updateConfig({ enabled: false });

      const result = await rewriter.rewrite('What is the best way to learn');

      expect(result.keywords).not.toContain('what');
      expect(result.keywords).not.toContain('the');
      expect(result.keywords).not.toContain('to');
    });

    it('should handle Chinese text', async () => {
      rewriter.updateConfig({ enabled: false });

      const result = await rewriter.rewrite('机器学习和深度学习的区别');

      expect(result.keywords.length).toBeGreaterThan(0);
    });

    it('should return top 5 keywords by frequency', async () => {
      rewriter.updateConfig({ enabled: false });

      const result = await rewriter.rewrite(
        'machine learning machine learning neural network neural deep learning'
      );

      expect(result.keywords.length).toBeLessThanOrEqual(5);
      expect(result.keywords[0]).toBe('learning');
      expect(result.keywords).toContain('machine');
    });
  });

  // ====== Language Detection ======

  describe('Language Detection', () => {
    it('should detect English', async () => {
      rewriter.updateConfig({ enabled: false });

      const result = await rewriter.rewrite('What is machine learning?');

      expect(result.originalLanguage).toBe('en');
    });

    it('should detect Chinese', async () => {
      rewriter.updateConfig({ enabled: false });

      const result = await rewriter.rewrite('什么是机器学习？');

      expect(result.originalLanguage).toBe('zh');
    });

    it('should detect mixed language', async () => {
      rewriter.updateConfig({ enabled: false });

      const result = await rewriter.rewrite('机器学习 AIML test');

      expect(result.originalLanguage).toBe('mixed');
    });

    it('should default to English for empty or special chars', async () => {
      rewriter.updateConfig({ enabled: false });

      const result = await rewriter.rewrite('123 456 !@#$%');

      expect(result.originalLanguage).toBe('en');
    });
  });

  // ====== API URL Construction ======

  describe('API URL Construction', () => {
    it('should append /chat/completions to base URL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content:
                    '{"original":"test","english":"test","chinese":"test","keywords":[],"originalLanguage":"en"}',
                },
              },
            ],
          }),
      });

      await rewriter.rewrite('test');

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toBe('https://api.openai.com/v1/chat/completions');
    });

    it('should handle base URL with trailing slash', async () => {
      rewriter.updateConfig({ baseUrl: 'https://api.example.com/v1/' });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content:
                    '{"original":"test","english":"test","chinese":"test","keywords":[],"originalLanguage":"en"}',
                },
              },
            ],
          }),
      });

      await rewriter.rewrite('test');

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toBe('https://api.example.com/v1/chat/completions');
    });

    it('should not double-append /chat/completions', async () => {
      rewriter.updateConfig({ baseUrl: 'https://api.example.com/v1/chat/completions' });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content:
                    '{"original":"test","english":"test","chinese":"test","keywords":[],"originalLanguage":"en"}',
                },
              },
            ],
          }),
      });

      await rewriter.rewrite('test');

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toBe('https://api.example.com/v1/chat/completions');
    });
  });
});

describe('QueryRewriter - Edge Cases', () => {
  let rewriter: QueryRewriter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);

    rewriter = new QueryRewriter({
      apiKey: 'test-key',
      enabled: false, // Test simple mode by default
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should handle empty query', async () => {
    const result = await rewriter.rewrite('');

    expect(result.original).toBe('');
    expect(result.keywords).toEqual([]);
  });

  it('should handle very long query', async () => {
    const longQuery = 'machine learning '.repeat(1000);
    const result = await rewriter.rewrite(longQuery);

    expect(result.original).toBe(longQuery);
    expect(result.keywords.length).toBeLessThanOrEqual(5);
  });

  it('should handle query with only special characters', async () => {
    const result = await rewriter.rewrite('!@#$%^&*()');

    expect(result.original).toBe('!@#$%^&*()');
    expect(result.keywords).toEqual([]);
  });

  it('should handle query with numbers', async () => {
    const result = await rewriter.rewrite('GPT-4 vs GPT-3.5 comparison 2024');

    expect(result.keywords).toContain('gpt');
    expect(result.keywords).toContain('comparison');
  });

  it('should handle Unicode characters', async () => {
    const result = await rewriter.rewrite('café résumé naïve 日本語 한국어');

    expect(result.original).toBe('café résumé naïve 日本語 한국어');
  });

  it('should handle newlines and tabs', async () => {
    const result = await rewriter.rewrite('line1\nline2\ttab');

    expect(result.original).toBe('line1\nline2\ttab');
  });

  it('should handle pronoun patterns in text', async () => {
    rewriter.updateConfig({ enabled: true, apiKey: 'key' });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  original: 'How does the transformer work?',
                  english: 'How does the transformer architecture work?',
                  chinese: '变换器架构是如何工作的？',
                  keywords: ['transformer', 'architecture'],
                  originalLanguage: 'en',
                }),
              },
            },
          ],
        }),
    });

    const history = [
      { role: 'user', content: 'Tell me about transformers' },
      { role: 'assistant', content: 'Transformers are...' },
    ];

    const result = await rewriter.rewrite('How does it work?', history);

    expect(mockFetch).toHaveBeenCalled();
    expect(result.english).toContain('transformer');
  });
});
