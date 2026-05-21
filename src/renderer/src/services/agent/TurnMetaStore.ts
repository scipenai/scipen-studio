/**
 * @file TurnMetaStore — IndexedDB cache for per-turn assistant metadata.
 *
 * SNACA's persisted history (ThreadMessage) carries only role + text + ts +
 * turn_id. The richer in-memory representation kept in ChatStreamStore —
 * thinking trace, tool calls, edit proposals, plan snapshot, usage — is
 * lost on any path that triggers a `hydrateThread`: switching threads,
 * restarting Studio, sidecar restart + ChatSidebar remount, etc.
 *
 * This store backs that loss with a Studio-local IndexedDB table keyed by
 * `(threadId, turnId)`. ChatStreamStore writes on `turn.done`; hydrate
 * merges back into `completedTurns` so ChatMessage renders the same
 * collapsed thinking / tool cards / proposal status the user originally
 * saw.
 *
 * Out of scope: cross-host sharing (snaca-cli/server still see thinking
 * dropped — that is by design in `ThreadMessage`'s wire shape). When a
 * future SNACA build persists thinking server-side, this cache becomes a
 * pure perf optimization rather than a correctness requirement.
 */

import type {
  ChatPlan,
  ChatProposalRecord,
  ChatTimelineEvent,
  ChatTurnUsage,
} from './ChatStreamStore';

const DB_NAME = 'scipen-studio.chat';
const DB_VERSION = 1;
const STORE = 'turn-meta';

export interface TurnMetaRecord {
  /** Composite key — `${threadId}::${turnId}`. */
  key: string;
  threadId: string;
  turnId: string;
  /** Absent on records written before the timeline rollout — treat as 'chat'. */
  origin?: 'chat' | 'composer';
  thinking: string;
  toolCalls: Array<{
    toolCallId: string;
    tool: string;
    args: unknown;
    status: 'pending' | 'progress' | 'success' | 'error';
    message?: string;
    result?: string;
  }>;
  /** Absent on legacy records — caller fabricates from thinking + toolCalls. */
  events?: ChatTimelineEvent[];
  proposals: ChatProposalRecord[];
  plan: ChatPlan | null;
  usage?: ChatTurnUsage;
  /** Wall-clock when the record was last written, used for future pruning. */
  ts: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * Open (or upgrade) the database lazily. Subsequent calls reuse the
 * resolved handle so we don't churn open/close on every write.
 */
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this environment'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('byThread', 'threadId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('failed to open IndexedDB'));
  });
  // If the open fails we reset so the next caller can retry rather than
  // permanently latching the rejected promise.
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function makeKey(threadId: string, turnId: string): string {
  return `${threadId}::${turnId}`;
}

/**
 * Persist a turn's metadata. Idempotent (`put` overwrites by key) — safe
 * to call repeatedly as a turn finalizes or when re-loading existing
 * history.
 */
export async function saveTurnMeta(record: TurnMetaRecord): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IDB tx aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IDB tx errored'));
    tx.objectStore(STORE).put(record);
  });
}

/** Bulk load every meta record for a thread (used during hydrate). */
export async function loadTurnMetaForThread(
  threadId: string
): Promise<TurnMetaRecord[]> {
  const db = await openDb();
  return await new Promise<TurnMetaRecord[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const index = store.index('byThread');
    const req = index.getAll(IDBKeyRange.only(threadId));
    req.onsuccess = () => resolve((req.result as TurnMetaRecord[]) ?? []);
    req.onerror = () => reject(req.error ?? new Error('IDB getAll failed'));
  });
}

/** Drop all meta records for a thread (used when SNACA deletes the thread). */
export async function deleteTurnMetaForThread(threadId: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IDB tx aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IDB tx errored'));
    const store = tx.objectStore(STORE);
    const index = store.index('byThread');
    const req = index.openCursor(IDBKeyRange.only(threadId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
  });
}

export { makeKey as turnMetaKey };
