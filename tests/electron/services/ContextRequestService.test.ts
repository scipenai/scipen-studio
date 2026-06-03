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
    expect(() =>
      service.completeFlush({ requestId: 'never-sent', flushedFiles: [] })
    ).not.toThrow();
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

  // ============ zotero_* ============

  it('zotero_search: forwards request and resolves when completeZotero arrives', async () => {
    const { service, send } = makeService();

    const handlePromise = service.handle({
      request_id: 'req-z1',
      turn_id: 'turn-1',
      kind: 'zotero_search',
      params: { query: 'attention', limit: 5 },
    });

    expect(send).toHaveBeenCalledWith(IpcChannel.Agent_ContextZoteroRequest, {
      requestId: 'req-z1',
      kind: 'zotero_search',
      params: { query: 'attention', limit: 5 },
    });

    service.completeZotero({
      requestId: 'req-z1',
      ok: true,
      data: {
        results: [
          {
            item_key: 'K1',
            citation_key: 'vaswani2017attention',
            title: 'Attention Is All You Need',
            year: 2017,
            score: 99,
          },
        ],
      },
    });

    const result = await handlePromise;
    expect(result.ok).toBe(true);
    expect(result.payload).toEqual({
      kind: 'zotero_search',
      results: [
        {
          item_key: 'K1',
          citation_key: 'vaswani2017attention',
          title: 'Attention Is All You Need',
          year: 2017,
          score: 99,
        },
      ],
    });
  });

  it('zotero_lookup: surfaces found=false verbatim', async () => {
    const { service } = makeService();
    const handlePromise = service.handle({
      request_id: 'req-z2',
      turn_id: 'turn-1',
      kind: 'zotero_lookup',
      params: { key: 'unknown2099' },
    });
    service.completeZotero({
      requestId: 'req-z2',
      ok: true,
      data: { found: false },
    });
    const result = await handlePromise;
    expect(result.ok).toBe(true);
    expect(result.payload).toEqual({ kind: 'zotero_lookup', found: false, item: undefined });
  });

  it('zotero_annotations: empty array is a valid response', async () => {
    const { service } = makeService();
    const handlePromise = service.handle({
      request_id: 'req-z3',
      turn_id: 'turn-1',
      kind: 'zotero_annotations',
      params: { item_key: 'PARENT' },
    });
    service.completeZotero({
      requestId: 'req-z3',
      ok: true,
      data: { annotations: [] },
    });
    const result = await handlePromise;
    expect(result.ok).toBe(true);
    expect(result.payload).toEqual({ kind: 'zotero_annotations', annotations: [] });
  });

  it('zotero: renderer ok=false bubbles up as host ok=false with the error message', async () => {
    const { service } = makeService();
    const handlePromise = service.handle({
      request_id: 'req-z4',
      turn_id: 'turn-1',
      kind: 'zotero_search',
      params: { query: 'foo' },
    });
    service.completeZotero({
      requestId: 'req-z4',
      ok: false,
      error: 'Zotero not connected',
    });
    const result = await handlePromise;
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Zotero not connected');
  });

  it('zotero: timeout after 5s converts to ok:false', async () => {
    const { service } = makeService();
    const handlePromise = service.handle({
      request_id: 'req-z5',
      turn_id: 'turn-1',
      kind: 'zotero_lookup',
      params: { key: 'x' },
    });
    // Run past the 5s reverse-RPC budget. Inner promise rejects → catch
    // converts to ok:false; advance microtasks too so the chained .catch
    // settles before we await the outer promise.
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(0);
    const result = await handlePromise;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/did not respond/i);
  });

  it('zotero: missing renderer fails immediately without waiting', async () => {
    const { service } = makeService({ webContents: [] });
    const result = await service.handle({
      request_id: 'req-z6',
      turn_id: 'turn-1',
      kind: 'zotero_search',
      params: { query: 'foo' },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no renderer attached/i);
  });

  it('zotero: shapeZoteroPayload tolerates missing fields with safe defaults', async () => {
    const { service } = makeService();
    const handlePromise = service.handle({
      request_id: 'req-z7',
      turn_id: 'turn-1',
      kind: 'zotero_search',
      params: { query: 'foo' },
    });
    // Renderer replies ok:true but data is missing — service should
    // default to empty results array rather than send undefined.
    service.completeZotero({ requestId: 'req-z7', ok: true });
    const result = await handlePromise;
    expect(result.ok).toBe(true);
    expect(result.payload).toEqual({ kind: 'zotero_search', results: [] });
  });

  it('dispose: pending zotero requests reject with disposed reason', async () => {
    const { service } = makeService();
    const pending = service.handle({
      request_id: 'req-z8',
      turn_id: 'turn-1',
      kind: 'zotero_search',
      params: { query: 'q' },
    });
    service.dispose();
    await vi.advanceTimersByTimeAsync(0);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/disposed/i);
  });
});
