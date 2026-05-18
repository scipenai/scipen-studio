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
 *   - For everything else (`codebase_search` / `symbol_def` /
 *     `diagnostics`): `{ ok: false, error: 'not_supported' }` — those are
 *     deferred to a later phase that owns the index.
 *
 * Single-instance service. DI: `{ getRendererWebContents, fileSystem }`.
 */

import { createHash } from 'node:crypto';
import type { BrowserWindow, WebContents } from 'electron';
import { IpcChannel } from '../../../../shared/ipc/channels';
import { createLogger } from '../LoggerService';
import type { IFileSystemService } from '../interfaces';
import type {
  ContextRequestParams,
  ContextRespondParams,
} from './protocol/schemas';
import type {
  ContextFlushResponsePayload,
  IContextRequestService,
} from './interfaces/IContextRequestService';

const logger = createLogger('ContextRequest');

/** Hard cap on how long we wait for the renderer to finish flushing. */
const FLUSH_TIMEOUT_MS = 5_000;

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

export class ContextRequestService implements IContextRequestService {
  private readonly pending = new Map<string, PendingFlush>();
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
      case 'codebase_search':
      case 'symbol_def':
      case 'diagnostics':
        return {
          request_id: req.request_id,
          ok: false,
          error: `kind '${req.kind}' not supported by host yet`,
        };
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

  dispose(): void {
    this.disposed = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('ContextRequestService disposed'));
    }
    this.pending.clear();
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
