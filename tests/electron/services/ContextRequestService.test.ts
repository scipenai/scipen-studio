/**
 * @file ContextRequestService.test.ts
 * @description Unit tests for the reverse-RPC dispatcher answering SNACA's
 *   `context.request`. Covers all five `kind`s plus the async flush_unsaved
 *   round-trip (request out → completeFlush in → handle resolves) and the
 *   5s timeout fallback that prevents the LLM from hanging.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../../../src/main/services/LoggerService', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { ContextRequestService } from '../../../src/main/services/agent/ContextRequestService';
import { IpcChannel } from '../../../shared/ipc/channels';

interface FakeWebContents {
  send: Mock;
}

function makeService(opts?: {
  webContents?: FakeWebContents[];
  readFile?: Mock;
}): {
  service: ContextRequestService;
  send: Mock;
  readFile: Mock;
} {
  const send = vi.fn();
  const wc: FakeWebContents = opts?.webContents?.[0] ?? { send };
  const targets = opts?.webContents ?? [wc];
  const readFile = opts?.readFile ?? vi.fn(async () => ({ content: 'hello world' }));

  const service = new ContextRequestService({
    getRendererWebContents: () => targets as unknown as Electron.WebContents[],
    fileSystem: {
      readFile,
    } as unknown as import('../../../src/main/services/interfaces').IFileSystemService,
  });
  return { service, send: wc.send, readFile };
}

describe('ContextRequestService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // ============ flush_unsaved ============

  it('flush_unsaved: forwards request to renderer and resolves when completeFlush arrives', async () => {
    const { service, send } = makeService();

    const handlePromise = service.handle({
      request_id: 'req-1',
      turn_id: 'turn-1',
      kind: 'flush_unsaved',
      params: { paths: ['/proj/a.tex'] },
    });

    // Send must have been invoked on the renderer with the exact channel.
    expect(send).toHaveBeenCalledWith(IpcChannel.Agent_ContextFlushRequest, {
      requestId: 'req-1',
      paths: ['/proj/a.tex'],
    });

    // Renderer replies before timeout.
    service.completeFlush({ requestId: 'req-1', flushedFiles: ['/proj/a.tex'] });

    const result = await handlePromise;
    expect(result).toEqual({
      request_id: 'req-1',
      ok: true,
      payload: { kind: 'flush_unsaved', flushed_files: ['/proj/a.tex'] },
    });
  });

  it('flush_unsaved: times out after 5s when renderer never replies', async () => {
    const { service } = makeService();

    const handlePromise = service.handle({
      request_id: 'req-timeout',
      turn_id: 'turn-1',
      kind: 'flush_unsaved',
      params: {},
    });

    // Advance just past the 5s hard cap.
    await vi.advanceTimersByTimeAsync(5_001);

    const result = await handlePromise;
    expect(result.ok).toBe(false);
    expect(result.request_id).toBe('req-timeout');
    expect(result.error).toMatch(/did not respond/i);
  });

  it('flush_unsaved: replies ok with empty list when no renderer is attached', async () => {
    const { service, send } = makeService({ webContents: [] });

    const result = await service.handle({
      request_id: 'req-empty',
      turn_id: 'turn-1',
      kind: 'flush_unsaved',
      params: {},
    });

    expect(send).not.toHaveBeenCalled();
    expect(result).toEqual({
      request_id: 'req-empty',
      ok: true,
      payload: { kind: 'flush_unsaved', flushed_files: [] },
    });
  });

  it('completeFlush: ignores unknown request_id without throwing', () => {
    const { service } = makeService();
    expect(() => service.completeFlush({ requestId: 'never-sent', flushedFiles: [] })).not.toThrow();
  });

  // ============ file_content ============

  it('file_content: reads via IFileSystemService and attaches sha256', async () => {
    const readFile = vi.fn(async (path: string) => ({ content: `body of ${path}` }));
    const { service } = makeService({ readFile });

    const result = await service.handle({
      request_id: 'req-fc',
      turn_id: 'turn-1',
      kind: 'file_content',
      params: { path: '/proj/main.tex' },
    });

    expect(readFile).toHaveBeenCalledWith('/proj/main.tex');
    expect(result.ok).toBe(true);
    if (!result.payload || result.payload.kind !== 'file_content') throw new Error('shape');
    expect(result.payload.path).toBe('/proj/main.tex');
    expect(result.payload.content).toBe('body of /proj/main.tex');
    expect(result.payload.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('file_content: surfaces fs errors as ok=false', async () => {
    const readFile = vi.fn(async () => {
      throw new Error('ENOENT');
    });
    const { service } = makeService({ readFile });

    const result = await service.handle({
      request_id: 'req-fc-err',
      turn_id: 'turn-1',
      kind: 'file_content',
      params: { path: '/nope' },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('ENOENT');
  });

  // ============ not-yet-supported kinds ============

  it.each(['codebase_search', 'symbol_def', 'diagnostics'] as const)(
    '%s: replies ok=false with "not supported"',
    async (kind) => {
      const { service } = makeService();

      // Each kind has different `params` shape; build per-kind.
      const params =
        kind === 'codebase_search'
          ? { query: 'foo' }
          : kind === 'symbol_def'
            ? { name: 'Foo' }
            : { path: '/a.tex' };

      const result = await service.handle({
        request_id: `req-${kind}`,
        turn_id: 'turn-1',
        kind,
        params,
      } as Parameters<typeof service.handle>[0]);

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not supported/i);
    }
  );

  // ============ lifecycle ============

  it('dispose: rejects pending flush promises and refuses subsequent calls', async () => {
    const { service } = makeService();

    const pending = service.handle({
      request_id: 'req-dispose',
      turn_id: 'turn-1',
      kind: 'flush_unsaved',
      params: {},
    });

    service.dispose();

    // The pending promise must not hang — it should be resolved as a rejection-converted ok:false.
    // The flush_unsaved branch catches rejections from its inner Promise and converts to ok:false.
    await vi.advanceTimersByTimeAsync(0);
    const result = await pending;
    expect(result.ok).toBe(false);
    // The disposed signal must surface so the host can distinguish a "we
    // shut down" failure from a real renderer timeout — same wire shape,
    // different error text.
    expect(result.error).toMatch(/disposed/i);

    // Post-dispose calls also short-circuit.
    const after = await service.handle({
      request_id: 'req-after',
      turn_id: 'turn-1',
      kind: 'file_content',
      params: { path: '/x' },
    });
    expect(after.ok).toBe(false);
    expect(after.error).toMatch(/disposed/i);
  });
});
