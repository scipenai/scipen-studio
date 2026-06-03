/**
 * @file InlineEditService.test.ts
 * @description Verifies the Ctrl+K inline-edit service. Mocks the `ai` SDK's
 *   `streamText` so we never touch a real provider, then asserts:
 *
 *     - start() rejects when AIService is not configured
 *     - start() returns turnId + emits onDelta per chunk + onComplete with
 *       the sanitised (fence-stripped) full text
 *     - cancel() aborts in-flight stream, emits onError(code: 'aborted')
 *     - concurrent turns get distinct ids and isolated controllers
 *     - dispose() aborts everything and short-circuits future starts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/services/LoggerService', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ----- ai SDK mock -----
//
// `streamText` returns an object with a `textStream` async iterator. We
// build one from a controllable script per test so we can interleave aborts.
const mockStreamText = vi.fn();

vi.mock('ai', () => ({
  streamText: (...args: unknown[]) => mockStreamText(...args),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => {
    const fn = Object.assign(
      vi.fn(() => ({ id: 'mock-openai' })),
      { chat: vi.fn(() => ({ id: 'mock-openai-chat' })) }
    );
    return fn;
  }),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => vi.fn(() => ({ id: 'mock-anthropic' }))),
}));

import { InlineEditService } from '../../../src/main/services/InlineEditService';
import type { AIConfig, IAIService } from '../../../src/main/services/interfaces';

// ============ Helpers ============

interface ScriptedStream {
  /** Successive `delta` chunks the iterator will yield. */
  chunks: string[];
  /**
   * If true, after yielding all `chunks` the iterator hangs awaiting the
   * `abortSignal` instead of completing. Use this to simulate a real LLM
   * still streaming when the user cancels.
   */
  hangAfterChunks?: boolean;
  /**
   * Optional: throw `AbortError` after this many chunks (simulates the
   * `ai` SDK reacting to `abortSignal` mid-iteration). Mutually exclusive
   * with `hangAfterChunks`.
   */
  throwAbortAfter?: number;
}

function makeStreamMock(
  script: ScriptedStream,
  abortSignal?: AbortSignal
): {
  textStream: AsyncIterable<string>;
} {
  return {
    textStream: (async function* () {
      let n = 0;
      for (const c of script.chunks) {
        await Promise.resolve();
        n += 1;
        if (script.throwAbortAfter !== undefined && n > script.throwAbortAfter) {
          const err = new Error('stream aborted');
          err.name = 'AbortError';
          throw err;
        }
        yield c;
      }
      if (script.hangAfterChunks) {
        // Resolve only when the abort signal fires.
        await new Promise<void>((resolve, reject) => {
          if (abortSignal?.aborted) {
            const err = new Error('stream aborted');
            err.name = 'AbortError';
            reject(err);
            return;
          }
          abortSignal?.addEventListener('abort', () => {
            const err = new Error('stream aborted');
            err.name = 'AbortError';
            reject(err);
          });
          // Also a safety timeout so a test bug doesn't hang vitest.
          setTimeout(() => resolve(), 1000);
        });
      }
    })(),
  } as { textStream: AsyncIterable<string> };
}

function makeAIService(cfg: AIConfig | null): IAIService {
  return {
    getConfig: () => cfg,
    isConfigured: () => cfg !== null,
    updateConfig: vi.fn(),
    getCompletion: vi.fn(),
    chat: vi.fn(),
    chatStream: vi.fn(),
    stopGeneration: vi.fn(),
    isGenerating: vi.fn(),
    testConnection: vi.fn(),
  } as unknown as IAIService;
}

const DEFAULT_CFG: AIConfig = {
  provider: 'deepseek',
  apiKey: 'sk-test',
  baseUrl: 'https://api.example.com',
  model: 'mock-model',
  temperature: 0.2,
  maxTokens: 1024,
};

/** Drain all microtasks until the service emits `done` or `error` for `turnId`. */
async function waitForTurn(
  svc: InlineEditService,
  turnId: string,
  timeoutMs = 1500
): Promise<{
  delta: string[];
  complete?: string;
  errorCode?: string;
  errorMessage?: string;
}> {
  const result = {
    delta: [] as string[],
    complete: undefined as string | undefined,
    errorCode: undefined as string | undefined,
    errorMessage: undefined as string | undefined,
  };
  const offDelta = svc.onDelta((e) => {
    if (e.turnId === turnId) result.delta.push(e.delta);
  });
  const offComplete = svc.onComplete((e) => {
    if (e.turnId === turnId) result.complete = e.fullText;
  });
  const offError = svc.onError((e) => {
    if (e.turnId === turnId) {
      result.errorCode = e.code;
      result.errorMessage = e.message;
    }
  });
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (result.complete !== undefined || result.errorCode !== undefined) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  offDelta.dispose();
  offComplete.dispose();
  offError.dispose();
  return result;
}

// ============ Tests ============

describe('InlineEditService', () => {
  beforeEach(() => {
    mockStreamText.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('start: rejects when AI is not configured', async () => {
    const svc = new InlineEditService({ aiService: makeAIService(null) });
    await expect(
      svc.start({
        instruction: 'make concise',
        selectedText: 'hello',
        language: 'latex',
      })
    ).rejects.toThrow(/not configured/i);
  });

  it('start: emits deltas in order + onComplete with sanitised full text', async () => {
    mockStreamText.mockImplementation(() =>
      // Wrap output in a code fence to verify stripping.
      makeStreamMock({ chunks: ['```latex\n', 'edited ', 'text\n', '```'] })
    );
    const svc = new InlineEditService({ aiService: makeAIService(DEFAULT_CFG) });

    const { turnId } = await svc.start({
      instruction: 'make concise',
      selectedText: 'verbose original',
      language: 'latex',
    });
    const result = await waitForTurn(svc, turnId);

    expect(result.delta).toEqual(['```latex\n', 'edited ', 'text\n', '```']);
    // Outer fence stripped, inner content preserved.
    expect(result.complete).toBe('edited text');
    expect(result.errorCode).toBeUndefined();
  });

  it('start: leaves un-fenced output as-is', async () => {
    mockStreamText.mockImplementation(() => makeStreamMock({ chunks: ['just plain ', 'text'] }));
    const svc = new InlineEditService({ aiService: makeAIService(DEFAULT_CFG) });

    const { turnId } = await svc.start({
      instruction: 'x',
      selectedText: 'y',
      language: 'plaintext',
    });
    const result = await waitForTurn(svc, turnId);
    expect(result.complete).toBe('just plain text');
  });

  it('cancel: aborts in-flight stream and emits onError(code: aborted)', async () => {
    // Hang after yielding 1 chunk; the real `ai` SDK respects abortSignal
    // by throwing AbortError, so we wire the mock the same way.
    mockStreamText.mockImplementation((opts: { abortSignal?: AbortSignal }) =>
      makeStreamMock({ chunks: ['a'], hangAfterChunks: true }, opts.abortSignal)
    );
    const svc = new InlineEditService({ aiService: makeAIService(DEFAULT_CFG) });

    const { turnId } = await svc.start({
      instruction: 'x',
      selectedText: 'y',
      language: 'plaintext',
    });

    // Let the first chunk land, then cancel while the stream is hung.
    await new Promise((r) => setTimeout(r, 30));
    const cancelResult = svc.cancel(turnId);
    expect(cancelResult.ok).toBe(true);

    const result = await waitForTurn(svc, turnId);
    expect(result.errorCode).toBe('aborted');
  });

  it('cancel: returns ok=false for unknown turnId', () => {
    const svc = new InlineEditService({ aiService: makeAIService(DEFAULT_CFG) });
    expect(svc.cancel('inline-never-existed').ok).toBe(false);
  });

  it('concurrent turns get distinct ids and run in parallel', async () => {
    mockStreamText.mockImplementation(() => makeStreamMock({ chunks: ['x'] }));
    const svc = new InlineEditService({ aiService: makeAIService(DEFAULT_CFG) });

    const a = await svc.start({ instruction: 'i', selectedText: 's', language: 'latex' });
    const b = await svc.start({ instruction: 'i', selectedText: 's', language: 'latex' });

    expect(a.turnId).not.toBe(b.turnId);
    const [ra, rb] = await Promise.all([waitForTurn(svc, a.turnId), waitForTurn(svc, b.turnId)]);
    expect(ra.complete).toBe('x');
    expect(rb.complete).toBe('x');
  });

  it('dispose: short-circuits future starts', async () => {
    const svc = new InlineEditService({ aiService: makeAIService(DEFAULT_CFG) });
    svc.dispose();
    await expect(
      svc.start({ instruction: 'i', selectedText: 's', language: 'latex' })
    ).rejects.toThrow(/disposed/i);
  });

  it('start: provider error surfaces as friendly message', async () => {
    mockStreamText.mockImplementation(() => ({
      textStream: (async function* () {
        throw new Error('401 Unauthorized');
        // Unreachable yield kept so TS infers the generator's yield type.
        // eslint-disable-next-line no-unreachable
        // biome-ignore lint/correctness/noUnreachable: intentional for type inference
        yield '';
      })(),
    }));
    const svc = new InlineEditService({ aiService: makeAIService(DEFAULT_CFG) });

    // Subscribe BEFORE start so we never race the fire.
    const errors: Array<{ turnId: string; message: string; code?: string }> = [];
    svc.onError((e) => errors.push(e));

    await svc.start({
      instruction: 'x',
      selectedText: 'y',
      language: 'plaintext',
    });

    // Drain microtasks until the catch path fires.
    for (let i = 0; i < 30 && errors.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(errors.length).toBe(1);
    expect(errors[0].code).toBe('provider_error');
    expect(errors[0].message).toMatch(/Invalid or expired API Key/i);
  });
});
