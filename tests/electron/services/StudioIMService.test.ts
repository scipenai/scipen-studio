import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/services/LoggerService', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

type MockResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
};

function jsonResponse(payload: unknown): MockResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => payload,
  };
}

describe('StudioIMService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // TODO: after the im-core internal HTTP layer refactor, the fetch mock no longer matches — needs rewriting with a createCore-level mock
  it.skip('completes connection and sync via polling when the main process lacks a WebSocket global', async () => {
    const pollMessage = {
      id: 'message-1',
      conversation_id: 'conversation-1',
      sender_id: 'user-1',
      sender_name: 'Tester',
      content: 'hello',
      content_type: 'text',
      created_at: '2026-03-08T02:30:00.000Z',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' } }))
      .mockResolvedValueOnce(jsonResponse({ messages: [] }))
      .mockResolvedValue(jsonResponse({ messages: [pollMessage] }));

    vi.stubGlobal('fetch', fetchMock);

    const { StudioIMService } = await import('../../../src/main/services/StudioIMService');
    const service = new StudioIMService();

    const snapshot = await service.connect({
      baseUrl: 'http://127.0.0.1:28081',
      token: 'test-token',
      conversationId: 'conversation-1',
    });

    expect(snapshot.state).toBe('connected');
    expect(snapshot.messages).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(30_100);

    const nextSnapshot = service.getSnapshot();
    expect(nextSnapshot.state).toBe('connected');
    expect(nextSnapshot.messages).toHaveLength(1);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);

    service.dispose();
  });

  it('truly rebuilds the IM connection when reconnecting with the same config after disconnect', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' } }))
      .mockResolvedValueOnce(jsonResponse({ messages: [] }))
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' } }))
      .mockResolvedValueOnce(jsonResponse({ messages: [] }));

    vi.stubGlobal('fetch', fetchMock);

    const { StudioIMService } = await import('../../../src/main/services/StudioIMService');
    const service = new StudioIMService();
    const config = {
      baseUrl: 'http://127.0.0.1:28081',
      token: 'test-token',
      conversationId: 'conversation-1',
    };

    const firstSnapshot = await service.connect(config);
    expect(firstSnapshot.state).toBe('connected');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    service.disconnect();
    expect(service.getSnapshot().state).toBe('disconnected');

    const secondSnapshot = await service.connect(config);
    expect(secondSnapshot.state).toBe('connected');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    service.dispose();
  });
});
