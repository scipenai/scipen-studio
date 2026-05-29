/**
 * @file ContextRequestService — host-side dispatcher for SNACA's
 *   `context.request` reverse-RPC.
 *
 * Wired into `IEditorProtocolClient.setContextRequestHandler`. SNACA tools
 * call `context.request { kind, params }` when they need fresh host state
 * (most commonly `flush_unsaved` before a `Read`). This service:
 *
 *   - For `flush_unsaved`: broadcasts `Agent_ContextFlushRequest` to all
 *     renderers; waits up to `FLUSH_TIMEOUT_MS` for one to reply via
 *     `Agent_ContextFlushResponse`. On timeout, replies `{ ok: false }` so
 *     the LLM doesn't hang.
 *   - For `file_content`: reads disk directly via `IFileSystemService` and
 *     attaches a sha256.
 *   - For `zotero_search` / `zotero_lookup` / `zotero_annotations`: forwards
 *     to the renderer via `Agent_ContextZoteroRequest`, parks the request,
 *     and resolves when the renderer answers (or 5s timeout fires).
 *
 * Single-instance service. DI: `{ getRendererWebContents, fileSystem }`.
 */

import { createHash } from 'node:crypto';
import type { BrowserWindow, WebContents } from 'electron';
import { IpcChannel } from '../../../../shared/ipc/channels';
import { createLogger } from '../LoggerService';
import type { IFileSystemService } from '../interfaces';
import type {
  ContextPayload,
  ContextRequestParams,
  ContextRespondParams,
} from './protocol/schemas';
import type {
  ContextFlushResponsePayload,
  ContextZoteroResponsePayload,
  IContextRequestService,
} from './interfaces/IContextRequestService';

const logger = createLogger('ContextRequest');

/** Hard cap on how long we wait for the renderer to finish flushing. */
const FLUSH_TIMEOUT_MS = 5_000;
/**
 * Zotero queries are renderer-served too (BBT/LocalAPI live there);
 * we keep the same 5s cap so a stuck renderer can't park the LLM
 * indefinitely.
 */
const ZOTERO_TIMEOUT_MS = 5_000;

export interface ContextRequestServiceDeps {
  /**
   * Returns the renderer(s) we should ask. We broadcast to all `BrowserWindow`
   * instances — only the active window will actually have unsaved tabs.
   */
  getRendererWebContents: () => WebContents[];
  fileSystem: IFileSystemService;
}

interface PendingFlush {
  resolve: (flushedFiles: string[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingZotero {
  resolve: (payload: ContextZoteroResponsePayload) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ContextRequestService implements IContextRequestService {
  private readonly pending = new Map<string, PendingFlush>();
  private readonly pendingZotero = new Map<string, PendingZotero>();
  private disposed = false;

  constructor(private readonly deps: ContextRequestServiceDeps) {}

  async handle(req: ContextRequestParams): Promise<ContextRespondParams> {
    if (this.disposed) {
      return { request_id: req.request_id, ok: false, error: 'host disposed' };
    }
    switch (req.kind) {
      case 'flush_unsaved':
        return this.handleFlushUnsaved(req);
      case 'file_content':
        return this.handleFileContent(req);
      case 'zotero_search':
      case 'zotero_lookup':
      case 'zotero_annotations':
      case 'zotero_read':
        return this.handleZotero(req);
    }
  }

  completeFlush(payload: ContextFlushResponsePayload): void {
    const entry = this.pending.get(payload.requestId);
    if (!entry) {
      logger.warn('completeFlush for unknown / expired requestId', {
        requestId: payload.requestId,
      });
      return;
    }
    this.pending.delete(payload.requestId);
    clearTimeout(entry.timer);
    entry.resolve(payload.flushedFiles);
  }

  completeZotero(payload: ContextZoteroResponsePayload): void {
    const entry = this.pendingZotero.get(payload.requestId);
    if (!entry) {
      logger.warn('completeZotero for unknown / expired requestId', {
        requestId: payload.requestId,
      });
      return;
    }
    this.pendingZotero.delete(payload.requestId);
    clearTimeout(entry.timer);
    entry.resolve(payload);
  }

  dispose(): void {
    this.disposed = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('ContextRequestService disposed'));
    }
    this.pending.clear();
    for (const [, entry] of this.pendingZotero) {
      clearTimeout(entry.timer);
      entry.reject(new Error('ContextRequestService disposed'));
    }
    this.pendingZotero.clear();
  }

  // ============ Handlers ============

  private async handleFlushUnsaved(
    req: Extract<ContextRequestParams, { kind: 'flush_unsaved' }>
  ): Promise<ContextRespondParams> {
    const targets = this.deps.getRendererWebContents();
    if (targets.length === 0) {
      logger.warn('flush_unsaved with no renderer attached');
      return {
        request_id: req.request_id,
        ok: true,
        payload: { kind: 'flush_unsaved', flushed_files: [] },
      };
    }

    const flushed = await new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(req.request_id)) {
          reject(new Error(`flush_unsaved timeout after ${FLUSH_TIMEOUT_MS}ms`));
        }
      }, FLUSH_TIMEOUT_MS);
      this.pending.set(req.request_id, { resolve, reject, timer });

      for (const wc of targets) {
        try {
          wc.send(IpcChannel.Agent_ContextFlushRequest, {
            requestId: req.request_id,
            paths: req.params.paths,
          });
        } catch (err) {
          logger.warn('failed to send flush request to renderer', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }).catch((err) => {
      logger.warn('flush_unsaved failed', { error: (err as Error).message });
      return null;
    });

    if (flushed === null) {
      return {
        request_id: req.request_id,
        ok: false,
        error: this.disposed
          ? 'host disposed during flush'
          : 'renderer did not respond to flush request',
      };
    }
    return {
      request_id: req.request_id,
      ok: true,
      payload: { kind: 'flush_unsaved', flushed_files: flushed },
    };
  }

  /**
   * Common reverse-RPC machinery for the three `zotero_*` kinds.
   * Mirrors `handleFlushUnsaved`: park the request, broadcast to the
   * renderer, await its reply, time out at `ZOTERO_TIMEOUT_MS`.
   *
   * Responder shape on success (per `ContextPayloadSchema`):
   *   - `zotero_search`      → `{ results: [...] }`
   *   - `zotero_lookup`      → `{ found, item? }`
   *   - `zotero_annotations` → `{ annotations: [...] }`
   *
   * The responder may legitimately return `ok: false` (e.g. user hasn't
   * connected Zotero yet); we surface that verbatim to SNACA so the
   * tool can show a friendly message rather than silently failing.
   */
  private async handleZotero(
    req: Extract<
      ContextRequestParams,
      { kind: 'zotero_search' | 'zotero_lookup' | 'zotero_annotations' | 'zotero_read' }
    >
  ): Promise<ContextRespondParams> {
    const targets = this.deps.getRendererWebContents();
    if (targets.length === 0) {
      return {
        request_id: req.request_id,
        ok: false,
        error: 'no renderer attached to serve Zotero request',
      };
    }

    const reply = await new Promise<ContextZoteroResponsePayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingZotero.delete(req.request_id)) {
          reject(new Error(`${req.kind} timeout after ${ZOTERO_TIMEOUT_MS}ms`));
        }
      }, ZOTERO_TIMEOUT_MS);
      this.pendingZotero.set(req.request_id, { resolve, reject, timer });

      // We broadcast to all targets; only the focused window will
      // actually serve the request (its ContextZoteroResponder is
      // attached). The reply itself only carries `requestId` so even
      // if multiple windows answer the last writer wins — but
      // `getRendererWebContents()` already prefers focus.
      for (const wc of targets) {
        try {
          wc.send(IpcChannel.Agent_ContextZoteroRequest, {
            requestId: req.request_id,
            kind: req.kind,
            params: req.params,
          });
        } catch (err) {
          logger.warn('failed to send zotero request to renderer', {
            kind: req.kind,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }).catch((err) => {
      logger.warn('zotero context request failed', {
        kind: req.kind,
        error: (err as Error).message,
      });
      return null;
    });

    if (reply === null) {
      return {
        request_id: req.request_id,
        ok: false,
        error: this.disposed
          ? 'host disposed during zotero request'
          : 'renderer did not respond to zotero request',
      };
    }
    if (!reply.ok) {
      return {
        request_id: req.request_id,
        ok: false,
        error: reply.error ?? 'renderer rejected zotero request',
      };
    }

    return {
      request_id: req.request_id,
      ok: true,
      payload: shapeZoteroPayload(req.kind, reply.data),
    };
  }

  private async handleFileContent(
    req: Extract<ContextRequestParams, { kind: 'file_content' }>
  ): Promise<ContextRespondParams> {
    try {
      const { content } = await this.deps.fileSystem.readFile(req.params.path);
      const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
      return {
        request_id: req.request_id,
        ok: true,
        payload: {
          kind: 'file_content',
          path: req.params.path,
          content,
          sha256,
        },
      };
    } catch (err) {
      return {
        request_id: req.request_id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/**
 * Coerce renderer reply data into the right `ContextPayload` shape.
 * Renderer is trusted (same user, same machine) — we don't re-validate
 * each field, only fill in defaults so SNACA never sees `undefined`
 * where it expects an array.
 */
function shapeZoteroPayload(
  kind: 'zotero_search' | 'zotero_lookup' | 'zotero_annotations' | 'zotero_read',
  data: unknown
): ContextPayload {
  const obj = (data ?? {}) as Record<string, unknown>;
  switch (kind) {
    case 'zotero_search':
      return {
        kind: 'zotero_search',
        results: (Array.isArray(obj.results) ? obj.results : []) as Extract<
          ContextPayload,
          { kind: 'zotero_search' }
        >['results'],
      };
    case 'zotero_lookup':
      return {
        kind: 'zotero_lookup',
        found: Boolean(obj.found),
        item: obj.item as Extract<ContextPayload, { kind: 'zotero_lookup' }>['item'],
      };
    case 'zotero_annotations':
      return {
        kind: 'zotero_annotations',
        annotations: (Array.isArray(obj.annotations) ? obj.annotations : []) as Extract<
          ContextPayload,
          { kind: 'zotero_annotations' }
        >['annotations'],
      };
    case 'zotero_read': {
      const tier = obj.tier === 'local' || obj.tier === 'mineru' ? obj.tier : 'none';
      const quality = obj.quality === 'good' || obj.quality === 'poor' ? obj.quality : undefined;
      return {
        kind: 'zotero_read',
        text: typeof obj.text === 'string' ? obj.text : '',
        truncated: Boolean(obj.truncated),
        tier,
        quality,
      };
    }
  }
}

export function createContextRequestService(
  deps: ContextRequestServiceDeps
): ContextRequestService {
  return new ContextRequestService(deps);
}

/**
 * Helper for the registry: defer-import `electron.BrowserWindow` so this
 * module stays unit-testable without spinning up Electron.
 *
 * Selection policy: prefer the currently focused window — in multi-window
 * setups that is the one the user is editing in, so its renderer is the
 * authoritative source of dirty tabs. Fall back to every live window if no
 * window currently holds focus (e.g. the user alt-tabbed away mid-turn).
 */
export function defaultGetRendererWebContents(
  BrowserWindow: typeof import('electron').BrowserWindow
): () => WebContents[] {
  return () => {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && !focused.isDestroyed()) {
      return [focused.webContents];
    }
    const wins: BrowserWindow[] = BrowserWindow.getAllWindows();
    return wins.filter((w) => !w.isDestroyed()).map((w) => w.webContents);
  };
}
