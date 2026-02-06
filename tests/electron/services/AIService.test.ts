/**
 * @file AIService.test.ts
 * @description Unit tests for AI service - configuration, chat, completion, polishing, formula generation
 * @depends vitest, ai, @ai-sdk/openai, @ai-sdk/anthropic, main/services/AIService, tests/setup
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ====== AI SDK Mocks ======

const mockGenerateText = vi.fn();
const mockStreamText = vi.fn();

vi.mock('ai', () => ({
  generateText: (...args: unknown[]) => mockGenerateText(...args),
  streamText: (...args: unknown[]) => mockStreamText(...args),
}));

const mockModel = { modelId: 'mock-model', provider: 'mock-provider' };

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => {
    // createOpenAI returns a function with .chat() method
    const fn = Object.assign(
      vi.fn(() => mockModel),
      {
        chat: vi.fn(() => mockModel),
      }
    );
    return fn;
  }),
}));
vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => vi.fn(() => mockModel)),
}));

// ====== DI Test Helpers ======

import { ServiceNames, createMockAIService, createMockContainer } from '../../setup';

import type { AIConfig, IAIService } from '../../../src/main/services/interfaces';

describe('AIService', () => {
  let aiService: typeof import('../../../src/main/services/AIService').aiService;

  beforeAll(async () => {
    const module = await import('../../../src/main/services/AIService');
    aiService = module.aiService;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateText.mockReset();
    mockStreamText.mockReset();
  });

  describe('updateConfig', () => {
    it('should not create client when API key is empty', () => {
      aiService.updateConfig({
        provider: 'openai',
        apiKey: '',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4',
        temperature: 0.7,
        maxTokens: 2048,
      });

      expect(aiService.isConfigured()).toBe(false);
    });

    it('should create client when API key is provided', () => {
      aiService.updateConfig({
        provider: 'openai',
        apiKey: 'test-api-key-12345',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4',
        temperature: 0.7,
        maxTokens: 2048,
      });

      expect(aiService.isConfigured()).toBe(true);
    });

    it('should update configuration values', () => {
      aiService.updateConfig({
        provider: 'openai',
        apiKey: 'test-key',
        baseUrl: 'https://custom.api.com/v1',
        model: 'gpt-3.5-turbo',
        temperature: 0.5,
        maxTokens: 1024,
      });

      expect(aiService.isConfigured()).toBe(true);
    });

    it('should handle different providers', () => {
      aiService.updateConfig({
        provider: 'deepseek',
        apiKey: 'deepseek-key',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        temperature: 0.7,
        maxTokens: 2048,
      });

      expect(aiService.isConfigured()).toBe(true);
    });

    it('should handle anthropic provider', () => {
      aiService.updateConfig({
        provider: 'anthropic',
        apiKey: 'anthropic-key',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-3-sonnet',
        temperature: 0.7,
        maxTokens: 4096,
      });

      expect(aiService.isConfigured()).toBe(true);
    });
  });

  describe('isConfigured', () => {
    it('should return false when not configured', () => {
      aiService.updateConfig({
        provider: 'openai',
        apiKey: '',
        baseUrl: '',
        model: '',
        temperature: 0.7,
        maxTokens: 2048,
      });

      expect(aiService.isConfigured()).toBe(false);
    });

    it('should return true when properly configured', () => {
      aiService.updateConfig({
        provider: 'openai',
        apiKey: 'valid-key',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4',
        temperature: 0.7,
        maxTokens: 2048,
      });

      expect(aiService.isConfigured()).toBe(true);
    });
  });

  describe('chat', () => {
    beforeEach(() => {
      aiService.updateConfig({
        provider: 'openai',
        apiKey: 'test-key',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4',
        temperature: 0.7,
        maxTokens: 2048,
      });
    });

    it('should call generateText with correct messages', async () => {
      mockGenerateText.mockResolvedValue({
        text: 'Hello, I am an AI assistant!',
      });

      const result = await aiService.chat([{ role: 'user', content: 'Hello' }]);

      expect(mockGenerateText).toHaveBeenCalled();
      expect(result).toBe('Hello, I am an AI assistant!');
    });

    it('should handle empty response', async () => {
      mockGenerateText.mockResolvedValue({
        text: '',
      });

      const result = await aiService.chat([{ role: 'user', content: 'Hello' }]);

      expect(result).toBe('');
    });

    it('should throw on API error', async () => {
      mockGenerateText.mockRejectedValue(new Error('API Error'));

      await expect(aiService.chat([{ role: 'user', content: 'Hello' }])).rejects.toThrow(
        'API Error'
      );
    });
  });

  describe('getCompletion', () => {
    beforeEach(() => {
      aiService.updateConfig({
        provider: 'openai',
        apiKey: 'test-key',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4',
        temperature: 0.7,
        maxTokens: 2048,
        completionModel: 'gpt-3.5-turbo',
      });
    });

    it('should use completion model when specified', async () => {
      mockGenerateText.mockResolvedValue({
        text: 'completed text',
      });

      const result = await aiService.getCompletion('def hello():');

      expect(result).toBe('completed text');
      expect(mockGenerateText).toHaveBeenCalled();
    });

    it('should handle completion error', async () => {
      mockGenerateText.mockRejectedValue(new Error('Completion failed'));

      await expect(aiService.getCompletion('def hello():')).rejects.toThrow('Completion failed');
    });
  });

  describe('polishText', () => {
    beforeEach(() => {
      aiService.updateConfig({
        provider: 'openai',
        apiKey: 'test-key',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4',
        temperature: 0.7,
        maxTokens: 2048,
      });
    });

    it('should polish text successfully', async () => {
      mockGenerateText.mockResolvedValue({
        text: 'Polished text with better grammar.',
      });

      const result = await aiService.polishText('text with bad grammer');

      expect(result).toBe('Polished text with better grammar.');
      expect(mockGenerateText).toHaveBeenCalled();
    });

    it('should handle polish error', async () => {
      mockGenerateText.mockRejectedValue(new Error('Polish failed'));

      await expect(aiService.polishText('some text')).rejects.toThrow('Polish failed');
    });

    it('should accept optional RAG context', async () => {
      mockGenerateText.mockResolvedValue({
        text: 'Polished with context.',
      });

      const result = await aiService.polishText('some text', 'context from knowledge base');

      expect(result).toBe('Polished with context.');
    });
  });

  describe('generateFormula', () => {
    beforeEach(() => {
      aiService.updateConfig({
        provider: 'openai',
        apiKey: 'test-key',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4',
        temperature: 0.7,
        maxTokens: 2048,
      });
    });

    it('should generate LaTeX formula', async () => {
      mockGenerateText.mockResolvedValue({
        text: 'E = mc^2',
      });

      const result = await aiService.generateFormula('energy mass equivalence');

      expect(result).toBe('E = mc^2');
      expect(mockGenerateText).toHaveBeenCalled();
    });

    it('should generate Typst formula', async () => {
      mockGenerateText.mockResolvedValue({
        text: '$E = m c^2$',
      });

      const result = await aiService.generateFormula('energy mass equivalence', 'typst');

      expect(result).toBe('$E = m c^2$');
    });

    it('should handle formula generation error', async () => {
      mockGenerateText.mockRejectedValue(new Error('Generation failed'));

      await expect(aiService.generateFormula('some formula')).rejects.toThrow('Generation failed');
    });
  });

  describe('reviewDocument', () => {
    beforeEach(() => {
      aiService.updateConfig({
        provider: 'openai',
        apiKey: 'test-key',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4',
        temperature: 0.7,
        maxTokens: 2048,
      });
    });

    it('should review content successfully', async () => {
      mockGenerateText.mockResolvedValue({
        text: 'This is a well-written paper.',
      });

      const result = await aiService.reviewDocument('\\section{Introduction} This is a paper.');

      expect(result).toBe('This is a well-written paper.');
      expect(mockGenerateText).toHaveBeenCalled();
    });

    it('should handle review error', async () => {
      mockGenerateText.mockRejectedValue(new Error('Review failed'));

      await expect(aiService.reviewDocument('some content')).rejects.toThrow('Review failed');
    });
  });

  describe('stopGeneration', () => {
    it('should return false when no generation in progress', () => {
      aiService.updateConfig({
        provider: 'openai',
        apiKey: 'test-key',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4',
        temperature: 0.7,
        maxTokens: 2048,
      });

      const result = aiService.stopGeneration();
      expect(result).toBe(false);
    });
  });

  describe('isGenerating', () => {
    beforeEach(() => {
      aiService.updateConfig({
        provider: 'openai',
        apiKey: 'test-key',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4',
        temperature: 0.7,
        maxTokens: 2048,
      });
    });

    it('should return false when idle', () => {
      expect(aiService.isGenerating()).toBe(false);
    });
  });

  describe('testConnection', () => {
    beforeEach(() => {
      aiService.updateConfig({
        provider: 'openai',
        apiKey: 'test-key',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4',
        temperature: 0.7,
        maxTokens: 2048,
      });
    });

    it('should return success on valid connection', async () => {
      mockGenerateText.mockResolvedValue({
        text: 'Hello!',
      });

      const result = await aiService.testConnection();

      expect(result.success).toBe(true);
      expect(result.message).toContain('Connected');
    });

    it('should return failure when not configured', async () => {
      aiService.updateConfig({
        provider: 'openai',
        apiKey: '',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4',
        temperature: 0.7,
        maxTokens: 2048,
      });

      const result = await aiService.testConnection();

      expect(result.success).toBe(false);
      expect(result.message).toContain('not configured');
    });

    it('should return failure on API error', async () => {
      aiService.updateConfig({
        provider: 'openai',
        apiKey: 'invalid-key',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4',
        temperature: 0.7,
        maxTokens: 2048,
      });

      mockGenerateText.mockRejectedValue(new Error('Invalid API key'));

      const result = await aiService.testConnection();

      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid API key');
    });
  });

  describe('Error Handling', () => {
    beforeEach(() => {
      aiService.updateConfig({
        provider: 'openai',
        apiKey: 'test-key',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4',
        temperature: 0.7,
        maxTokens: 2048,
      });
    });

    it('should handle network timeout', async () => {
      mockGenerateText.mockRejectedValue(new Error('ETIMEDOUT'));

      await expect(aiService.chat([{ role: 'user', content: 'Hello' }])).rejects.toThrow(
        'ETIMEDOUT'
      );
    });

    it('should handle rate limit error', async () => {
      mockGenerateText.mockRejectedValue(new Error('Rate limit exceeded'));

      await expect(aiService.chat([{ role: 'user', content: 'Hello' }])).rejects.toThrow(
        'Rate limit'
      );
    });
  });
});

describe('AIService - Type Definitions', () => {
  it('AIConfig should contain required fields', () => {
    const config: AIConfig = {
      provider: 'openai',
      apiKey: 'key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4',
      temperature: 0.7,
      maxTokens: 2048,
    };

    expect(config.provider).toBe('openai');
  });

  it('AIMessage should contain required fields', () => {
    interface AIMessage {
      role: 'user' | 'assistant' | 'system';
      content: string;
    }

    const message: AIMessage = {
      role: 'user',
      content: 'Hello',
    };

    expect(message.role).toBe('user');
    expect(message.content).toBe('Hello');
  });
});

// ====== DI Mock Pattern Examples ======

describe('AIService - DI Mock Pattern (Examples)', () => {
  /**
   * Demonstrates how to use MockServiceContainer to test components/handlers that depend on AIService
   */

  describe('Using createMockAIService for isolated tests', () => {
    it('should create a mock service with default values', () => {
      const mockService = createMockAIService();

      expect(mockService.isConfigured()).toBe(false);

      expect(mockService.chat).toBeDefined();
      expect(mockService.polishText).toBeDefined();
    });

    it('should create a mock service with custom configuration', () => {
      const mockService = createMockAIService({
        isConfigured: true,
        chatResponse: 'Custom AI response',
        testConnectionResult: { success: true, message: 'All systems go!' },
      });

      expect(mockService.isConfigured()).toBe(true);
    });

    it('should allow verifying method calls', async () => {
      const mockService = createMockAIService({
        isConfigured: true,
        chatResponse: 'Hello from mock!',
      });

      const result = await mockService.chat([{ role: 'user', content: 'Hi' }]);

      expect(result).toBe('Hello from mock!');
      expect(mockService.chat).toHaveBeenCalledWith([{ role: 'user', content: 'Hi' }]);
    });
  });

  describe('Using createMockContainer for integration tests', () => {
    it('should create a container with mock services', () => {
      const container = createMockContainer({
        aiService: createMockAIService({ isConfigured: true }),
      });

      const aiService = container.get<IAIService>(ServiceNames.AI);

      expect(aiService.isConfigured()).toBe(true);
    });

    it('should allow overriding specific services', async () => {
      const customAIService = createMockAIService({
        chatResponse: 'Custom response for integration test',
      });

      const container = createMockContainer({
        aiService: customAIService,
      });

      const service = container.get<IAIService>(ServiceNames.AI);
      const result = await service.chat([{ role: 'user', content: 'test' }]);

      expect(result).toBe('Custom response for integration test');
    });
  });

  describe('IPC Handler testing pattern', () => {
    /**
     * Demonstrates how to test IPC handlers that depend on AI service without connecting to real AI API
     */
    it('should demonstrate handler testing pattern', async () => {
      const mockAI = createMockAIService({
        isConfigured: true,
        polishResponse: 'Enhanced text with AI improvements.',
      });

      async function handlePolishRequest(
        aiService: IAIService,
        text: string
      ): Promise<{ success: boolean; result: string }> {
        if (!aiService.isConfigured()) {
          return { success: false, result: 'AI not configured' };
        }
        const polished = await aiService.polishText(text);
        return { success: true, result: polished };
      }

      const response = await handlePolishRequest(mockAI, 'rough text');

      expect(response.success).toBe(true);
      expect(response.result).toBe('Enhanced text with AI improvements.');
      expect(mockAI.polishText).toHaveBeenCalledWith('rough text');
    });
  });
});
