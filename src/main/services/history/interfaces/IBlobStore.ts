/**
 * @file IBlobStore - content-addressed blob storage contract.
 * @description Stores file snapshots by their BLAKE3-256 hash. The writer is
 *   only required to be eventually consistent (chunk/step writes can outlive
 *   the editing turn that produced them), so `put` is idempotent and `get` may
 *   be served from either the inline DB row or the on-disk file — same hash,
 *   same bytes, full stop.
 */

import type { Hash } from '../types';

export interface IBlobStore {
  /**
   * Hash `bytes`, persist if not already present, return the hash. Idempotent:
   * a second call with the same bytes is a no-op aside from refcount.
   */
  put(bytes: Uint8Array): Promise<Hash>;

  /** Return the bytes for `hash` or `null` if unknown. */
  get(hash: Hash): Promise<Uint8Array | null>;

  /** True if a blob with this hash exists. Cheaper than `get` for refcount-only paths. */
  has(hash: Hash): Promise<boolean>;

  /** Increment the refcount. Caller wraps in a transaction with the dependent insert. */
  incRef(hash: Hash, by?: number): Promise<void>;

  /** Decrement the refcount. Reaching 0 marks the blob as a GC candidate (sweep is separate). */
  decRef(hash: Hash, by?: number): Promise<void>;

  /**
   * One-shot disposal: flush in-flight writes, release file handles. After
   * `dispose` no method may be called on the store.
   */
  dispose(): Promise<void>;
}
