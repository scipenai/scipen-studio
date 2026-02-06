/**
 * @file ChatOrchestrator.test.ts
 * @description Tests for chat orchestrator - session management, message streaming, @ mentions, RAG integration
 * @depends vitest, electron, main/services/chat/ChatOrchestrator
 */

import { EventEmitter } from 'events';
import type { WebContents } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IAIService, StreamChunk } from '../../../src/main/services/interfaces/IAIService';
import type { IFileSystemService } from '../../../src/main/services/interfaces/IFileSystemService';

// Mock electron
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/scipen-studio-test'),
  },
}));

// Mock knowledge service
vi.mock('../../../src/main/services/knowledge/MultimodalKnowledgeService', () => ({
  getKnowledgeService: vi.fn(() => null),
}));

// ============ Mock Factories ============

function createMockAIService(
  options: {
    chatResponse?: string;
    streamChunks?: StreamChunk[];
  } = {}
): IAIService {
  const {
    chatResponse = 'Mock AI response',
    streamChunks = [
      { type: 'chunk', content: 'Hello ' },
      { type: 'chunk', content: 'World!' },
      { type: 'complete', content: 'Hello World!' },
    ],
  } = options;

  return {
    updateConfig: vi.fn(),
    getConfig: vi.fn(() => null),
    isConfigured: vi.fn(() => true),
    getCompletion: vi.fn().mockResolvedValue('completion'),
    polishText: vi.fn().mockResolvedValue('polished'),
    chat: vi.fn().mockResolvedValue(chatResponse),
    chatStream: vi.fn(async function* (): AsyncGenerator<StreamChunk> {
      for (const chunk of streamChunks) {
        yield chunk;
      }
    }),
    stopGeneration: vi.fn(() => false),
    isGenerating: vi.fn(() => false),
    generateFormula: vi.fn().mockResolvedValue('formula'),
    reviewDocument: vi.fn().mockResolvedValue('review'),
    testConnection: vi.fn().mockResolvedValue({ success: true, message: 'OK' }),
  };
}

function createMockFileSystemService(): IFileSystemService {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    readFile: vi.fn().mockResolvedValue({ content: '', mtime: Date.now() }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    buildFileTree: vi
      .fn()
      .mockResolvedValue({ name: 'root', path: '/', type: 'directory', children: [] }),
    resolveChildren: vi.fn().mockResolvedValue([]),
    scanFilePaths: vi.fn().mockResolvedValue([]),
    startWatching: vi.fn().mockResolvedValue(undefined),
    stopWatching: vi.fn().mockResolvedValue(undefined),
    recordFileMtime: vi.fn().mockResolvedValue(undefined),
    updateFileMtime: vi.fn(),
    getCachedMtime: vi.fn(() => undefined),
    getFileExtension: vi.fn((path: string) => `.${path.split('.').pop()}`),
    isLaTeXFile: vi.fn((path: string) => path.endsWith('.tex')),
    findMainTexFile: vi.fn().mockResolvedValue(null),
    findFiles: vi.fn().mockResolvedValue([]),
  }) as IFileSystemService;
}

function createMockWebContents(): WebContents {
  return {
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  } as unknown as WebContents;
}

async function waitForEventCount(
  webContents: WebContents,
  type: string,
  count: number,
  timeoutMs = 500
): Promise<void> {
  const start = Date.now();
  const sendMock = webContents.send as ReturnType<typeof vi.fn>;

  while (Date.now() - start < timeoutMs) {
    const matches = sendMock.mock.calls.filter((call) => call[1]?.type === type).length;
    if (matches >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error(`Timeout waiting for ${count} '${type}' events`);
}

async function waitForEvent(
  webContents: WebContents,
  type: string,
  timeoutMs = 500
): Promise<void> {
  return waitForEventCount(webContents, type, 1, timeoutMs);
}

// ============ Tests ============

describe('ChatOrchestrator', () => {
  let ChatOrchestrator: typeof import(
    '../../../src/main/services/chat/ChatOrchestrator'
  ).ChatOrchestrator;
  let orchestrator: InstanceType<typeof ChatOrchestrator>;
  let mockAIService: IAIService;
  let mockFileService: IFileSystemService;
  let mockWebContents: WebContents;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Dynamic import ensures mocks are applied
    const module = await import('../../../src/main/services/chat/ChatOrchestrator');
    ChatOrchestrator = module.ChatOrchestrator;

    mockAIService = createMockAIService();
    mockFileService = createMockFileSystemService();
    mockWebContents = createMockWebContents();

    orchestrator = new ChatOrchestrator(mockAIService, mockFileService);
  });

  // ============ Session Management ============

  describe('Session Management', () => {
    it('should create a new session', () => {
      const session = orchestrator.createSession();

      expect(session).toBeDefined();
      expect(session.id).toBeTruthy();
      expect(session.title).toBe('New Conversation');
      expect(session.status).toBe('idle');
      expect(session.messageCount).toBe(0);
    });

    it('should create session with knowledge base ID', () => {
      const kbId = 'kb-123';
      const session = orchestrator.createSession(kbId);

      expect(session.knowledgeBaseId).toBe(kbId);
    });

    it('should get existing session', () => {
      const created = orchestrator.createSession();
      const retrieved = orchestrator.getSession(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
    });

    it('should return undefined for non-existent session', () => {
      const session = orchestrator.getSession('non-existent-id');
      expect(session).toBeUndefined();
    });

    it('should get all sessions', () => {
      orchestrator.createSession();
      orchestrator.createSession();
      orchestrator.createSession();

      const sessions = orchestrator.getSessions();
      expect(sessions).toHaveLength(3);
    });

    it('should delete session', () => {
      const session = orchestrator.createSession();
      const deleted = orchestrator.deleteSession(session.id);

      expect(deleted).toBe(true);
      expect(orchestrator.getSession(session.id)).toBeUndefined();
    });

    it('should return false when deleting non-existent session', () => {
      const deleted = orchestrator.deleteSession('non-existent-id');
      expect(deleted).toBe(false);
    });

    it('should rename session', () => {
      const session = orchestrator.createSession();
      const newTitle = 'My New Conversation';
      const renamed = orchestrator.renameSession(session.id, newTitle);

      expect(renamed).toBe(true);
      expect(orchestrator.getSession(session.id)?.title).toBe(newTitle);
    });

    it('should return false when renaming non-existent session', () => {
      const renamed = orchestrator.renameSession('non-existent-id', 'New Title');
      expect(renamed).toBe(false);
    });
  });

  // ============ Message Sending ============

  describe('Message Sending', () => {
    it('should send message and create new session', async () => {
      const result = await orchestrator.sendMessage(null, 'Hello, AI!', {}, mockWebContents);

      expect(result.sessionId).toBeTruthy();
      expect(result.userMessageId).toBeTruthy();
    });

    it('should send message to existing session', async () => {
      const session = orchestrator.createSession();

      const result = await orchestrator.sendMessage(
        session.id,
        'Hello again!',
        {},
        mockWebContents
      );

      expect(result.sessionId).toBe(session.id);
    });

    it('should throw error for non-existent session', async () => {
      await expect(
        orchestrator.sendMessage('non-existent', 'Hello', {}, mockWebContents)
      ).rejects.toThrow('Session not found');
    });

    it('should emit session_created event for new sessions', async () => {
      await orchestrator.sendMessage(null, 'Hello', {}, mockWebContents);

      await waitForEvent(mockWebContents, 'session_created');

      expect(mockWebContents.send).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ type: 'session_created' })
      );
    });

    it('should emit message_start event', async () => {
      await orchestrator.sendMessage(null, 'Hello', {}, mockWebContents);

      await waitForEvent(mockWebContents, 'message_start');

      expect(mockWebContents.send).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ type: 'message_start', role: 'assistant' })
      );
    });

    it('should emit text_delta events during streaming', async () => {
      await orchestrator.sendMessage(null, 'Hello', {}, mockWebContents);

      await waitForEvent(mockWebContents, 'done');

      const textDeltaCalls = (mockWebContents.send as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => call[1]?.type === 'text_delta'
      );

      expect(textDeltaCalls.length).toBeGreaterThan(0);
    });

    it('should emit done event after completion', async () => {
      await orchestrator.sendMessage(null, 'Hello', {}, mockWebContents);

      await waitForEvent(mockWebContents, 'done');

      expect(mockWebContents.send).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ type: 'done' })
      );
    });
  });

  // ============ Message History ============

  describe('Message History', () => {
    it('should retrieve messages from session', async () => {
      const result = await orchestrator.sendMessage(null, 'Hello', {}, mockWebContents);

      await waitForEvent(mockWebContents, 'done');

      const { messages } = orchestrator.getMessages(result.sessionId);

      expect(messages.length).toBeGreaterThanOrEqual(1);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toBe('Hello');
    });

    it('should return empty messages for new session', () => {
      const session = orchestrator.createSession();
      const { messages, hasMore } = orchestrator.getMessages(session.id);

      expect(messages).toHaveLength(0);
      expect(hasMore).toBe(false);
    });

    it('should respect limit parameter', async () => {
      const session = orchestrator.createSession();

      // Send multiple messages
      for (let i = 0; i < 5; i++) {
        await orchestrator.sendMessage(session.id, `Message ${i}`, {}, mockWebContents);
        await waitForEventCount(mockWebContents, 'done', i + 1);
      }

      const { messages, hasMore } = orchestrator.getMessages(session.id, 3);
      expect(messages).toHaveLength(3);
      expect(hasMore).toBe(true);
    });
  });

  // ============ Generation Control ============

  describe('Generation Control', () => {
    it('should reset generating status after completion', async () => {
      const result = await orchestrator.sendMessage(null, 'Hello', {}, mockWebContents);

      await waitForEvent(mockWebContents, 'done');

      expect(orchestrator.isGenerating(result.sessionId)).toBe(false);
    });

    it('should cancel ongoing generation', async () => {
      let releaseStream: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseStream = resolve;
      });

      const slowAIService = createMockAIService({ streamChunks: [] });
      (slowAIService.chatStream as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
        await gate;
        yield { type: 'chunk', content: 'late' };
        yield { type: 'complete', content: 'late' };
      });

      const slowOrchestrator = new ChatOrchestrator(slowAIService, mockFileService);
      const result = await slowOrchestrator.sendMessage(null, 'Hello', {}, mockWebContents);

      slowOrchestrator.cancelGeneration(result.sessionId);
      releaseStream!();

      await waitForEvent(mockWebContents, 'cancelled');
      expect(slowOrchestrator.isGenerating(result.sessionId)).toBe(false);
    });

    it('should handle cancel on idle session', () => {
      const session = orchestrator.createSession();

      // Should not throw
      orchestrator.cancelGeneration(session.id);
      expect(orchestrator.isGenerating(session.id)).toBe(false);
    });
  });

  // ============ Error Handling ============

  describe('Error Handling', () => {
    it('should handle AI service errors gracefully', async () => {
      const errorAIService = createMockAIService();
      (errorAIService.chatStream as ReturnType<typeof vi.fn>).mockImplementation(
        async function* () {
          yield { type: 'error', error: 'AI service unavailable' };
        }
      );

      const errorOrchestrator = new ChatOrchestrator(errorAIService, mockFileService);

      await errorOrchestrator.sendMessage(null, 'Hello', {}, mockWebContents);

      await waitForEvent(mockWebContents, 'error');

      expect(mockWebContents.send).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ type: 'error' })
      );
    });

    it('should not send to destroyed webContents', async () => {
      const destroyedWebContents = createMockWebContents();
      (destroyedWebContents.isDestroyed as ReturnType<typeof vi.fn>).mockReturnValue(true);

      await orchestrator.sendMessage(null, 'Hello', {}, destroyedWebContents);

      // Give async tasks a tick
      await new Promise((resolve) => setTimeout(resolve, 50));

      // send should not be called because webContents is destroyed
      expect(destroyedWebContents.send).not.toHaveBeenCalled();
    });
  });

  // ============ RAG Integration ============

  describe('RAG Integration', () => {
    it('should emit rag_search_start when knowledge base is selected', async () => {
      await orchestrator.sendMessage(
        null,
        'What is machine learning?',
        { knowledgeBaseId: 'kb-123' },
        mockWebContents
      );

      await waitForEvent(mockWebContents, 'rag_search_start');

      expect(mockWebContents.send).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ type: 'rag_search_start' })
      );
    });

    it('should emit rag_search_complete after search', async () => {
      await orchestrator.sendMessage(
        null,
        'Explain transformers',
        { knowledgeBaseId: 'kb-456' },
        mockWebContents
      );

      await waitForEvent(mockWebContents, 'rag_search_complete');

      expect(mockWebContents.send).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ type: 'rag_search_complete' })
      );
    });
  });

  // ============ Disposal ============

  describe('Disposal', () => {
    it('should dispose cleanly', () => {
      orchestrator.createSession();
      orchestrator.createSession();

      // Should not throw
      expect(() => orchestrator.dispose()).not.toThrow();
    });

    it('should abort ongoing generations on dispose', async () => {
      await orchestrator.sendMessage(null, 'Long running task', {}, mockWebContents);

      // Dispose while potentially generating
      orchestrator.dispose();

      // Sessions should be cleared
      expect(orchestrator.getSessions()).toHaveLength(0);
    });
  });
});

describe('ChatOrchestrator - Edge Cases', () => {
  let ChatOrchestrator: typeof import(
    '../../../src/main/services/chat/ChatOrchestrator'
  ).ChatOrchestrator;

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await import('../../../src/main/services/chat/ChatOrchestrator');
    ChatOrchestrator = module.ChatOrchestrator;
  });

  it('should handle empty message content', async () => {
    const mockAI = createMockAIService();
    const mockFS = createMockFileSystemService();
    const mockWC = createMockWebContents();
    const orchestrator = new ChatOrchestrator(mockAI, mockFS);

    // Empty message should still work
    const result = await orchestrator.sendMessage(null, '', {}, mockWC);
    expect(result.sessionId).toBeTruthy();
  });

  it('should handle very long message content', async () => {
    const mockAI = createMockAIService();
    const mockFS = createMockFileSystemService();
    const mockWC = createMockWebContents();
    const orchestrator = new ChatOrchestrator(mockAI, mockFS);

    const longMessage = 'A'.repeat(100000);
    const result = await orchestrator.sendMessage(null, longMessage, {}, mockWC);
    expect(result.sessionId).toBeTruthy();
  });

  it('should handle special characters in messages', async () => {
    const mockAI = createMockAIService();
    const mockFS = createMockFileSystemService();
    const mockWC = createMockWebContents();
    const orchestrator = new ChatOrchestrator(mockAI, mockFS);

    const specialMessage = '\\LaTeX $x^2$ @file.tex 中文 émojis 🚀';
    const result = await orchestrator.sendMessage(null, specialMessage, {}, mockWC);
    expect(result.sessionId).toBeTruthy();
  });

  it('should handle concurrent message sends', async () => {
    const mockAI = createMockAIService();
    const mockFS = createMockFileSystemService();
    const mockWC = createMockWebContents();
    const orchestrator = new ChatOrchestrator(mockAI, mockFS);

    const session = orchestrator.createSession();

    // Send multiple messages concurrently
    const promises = [
      orchestrator.sendMessage(session.id, 'Message 1', {}, mockWC),
      orchestrator.sendMessage(session.id, 'Message 2', {}, mockWC),
      orchestrator.sendMessage(session.id, 'Message 3', {}, mockWC),
    ];

    // Should handle without errors (last one wins, previous cancelled)
    const results = await Promise.all(promises);
    expect(results.every((r) => r.sessionId === session.id)).toBe(true);
  });
});
