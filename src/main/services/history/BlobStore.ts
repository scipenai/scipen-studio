/**
 * @file BlobStore - filesystem-backed content-addressed blob store.
 *
 * M1 stub: surface only. The hashing + disk IO + refcount come in M2. A pure
 * stub now keeps the IPC and consumer modules typecheckable without forcing the
 * blob layer into the critical path before its tests exist.
 */

import { createLogger } from '../LoggerService';
import type { IBlobStore } from './interfaces/IBlobStore';
import type { Hash } from './types';

const logger = createLogger('BlobStore');

export interface BlobStoreOptions {
  /** Absolute path to the per-project history root (`{...}/history/`). */
  rootDir: string;
  /** Inline threshold; bytes shorter than this never hit disk. */
  inlineMaxBytes: number;
}

export class BlobStore implements IBlobStore {
  constructor(private readonly opts: BlobStoreOptions) {
    void this.opts;
    logger.debug('BlobStore stub constructed (M1)');
  }

  put(_bytes: Uint8Array): Promise<Hash> {
    throw new Error('BlobStore.put not implemented yet (M2)');
  }

  get(_hash: Hash): Promise<Uint8Array | null> {
    throw new Error('BlobStore.get not implemented yet (M2)');
  }

  has(_hash: Hash): Promise<boolean> {
    throw new Error('BlobStore.has not implemented yet (M2)');
  }

  incRef(_hash: Hash, _by = 1): Promise<void> {
    throw new Error('BlobStore.incRef not implemented yet (M2)');
  }

  decRef(_hash: Hash, _by = 1): Promise<void> {
    throw new Error('BlobStore.decRef not implemented yet (M2)');
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

export function createBlobStore(opts: BlobStoreOptions): BlobStore {
  return new BlobStore(opts);
}
