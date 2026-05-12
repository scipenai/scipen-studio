import { BrowserWindow, type WebContents } from 'electron';
import type { CollaborationBackend } from '../../../shared/ipc/im-contract';
import { createLogger } from './LoggerService';

const logger = createLogger('CollaborationOwnerRegistry');

export type { CollaborationBackend };

export interface CollaborationOwner {
  backend: CollaborationBackend;
  windowId: number;
  projectId: string | null;
  rootPath: string | null;
  fileId: string | null;
  claimedAt: number;
}

function normalizeNullable(value?: string | null): string | null {
  const normalized = (value ?? '').trim();
  return normalized ? normalized : null;
}

export class CollaborationOwnerRegistry {
  private readonly owners = new Map<CollaborationBackend, CollaborationOwner>();

  setActive(owner: {
    backend: CollaborationBackend;
    windowId: number;
    projectId?: string | null;
    rootPath?: string | null;
    fileId?: string | null;
  }): CollaborationOwner {
    const next: CollaborationOwner = {
      backend: owner.backend,
      windowId: owner.windowId,
      projectId: normalizeNullable(owner.projectId),
      rootPath: normalizeNullable(owner.rootPath),
      fileId: normalizeNullable(owner.fileId),
      claimedAt: Date.now(),
    };
    this.owners.set(owner.backend, next);
    logger.info(
      `[owner] ${owner.backend} -> window=${owner.windowId} project=${next.projectId ?? '-'} file=${next.fileId ?? '-'}`
    );
    return next;
  }

  clear(params: {
    backend: CollaborationBackend;
    windowId?: number | null;
  }): void {
    const existing = this.owners.get(params.backend);
    if (!existing) return;
    if (params.windowId != null && existing.windowId !== params.windowId) {
      return;
    }
    this.owners.delete(params.backend);
    logger.info(
      `[owner] cleared ${params.backend}${params.windowId != null ? ` for window=${params.windowId}` : ''}`
    );
  }

  clearWindow(windowId: number): void {
    for (const [backend, owner] of this.owners.entries()) {
      if (owner.windowId === windowId) {
        this.owners.delete(backend);
        logger.info(`[owner] cleared ${backend} due to window close: ${windowId}`);
      }
    }
  }

  getOwner(backend: CollaborationBackend): CollaborationOwner | null {
    return this.owners.get(backend) ?? null;
  }

  sendToOwner(backend: CollaborationBackend, channel: string, payload: unknown): boolean {
    const owner = this.getOwner(backend);
    if (!owner) return false;
    const win = BrowserWindow.fromId(owner.windowId);
    if (!win || win.isDestroyed()) {
      this.owners.delete(backend);
      logger.warn(`[owner] stale owner removed for ${backend}: ${owner.windowId}`);
      return false;
    }
    win.webContents.send(channel, payload);
    return true;
  }

  isOwnerWebContents(backend: CollaborationBackend, webContents: WebContents): boolean {
    const owner = this.getOwner(backend);
    return owner?.windowId === BrowserWindow.fromWebContents(webContents)?.id;
  }

  /**
   * Called on window blur: only clears ownership when the given window is the current owner.
   * Prevents window A's blur from clobbering ownership that window B just claimed.
   */
  releaseIfOwner(backend: CollaborationBackend, windowId: number): boolean {
    const owner = this.getOwner(backend);
    if (!owner || owner.windowId !== windowId) return false;
    this.owners.delete(backend);
    logger.info(`[owner] released ${backend} from window=${windowId} (blur)`);
    return true;
  }
}

let registry: CollaborationOwnerRegistry | null = null;

export function getCollaborationOwnerRegistry(): CollaborationOwnerRegistry {
  if (!registry) {
    registry = new CollaborationOwnerRegistry();
  }
  return registry;
}
