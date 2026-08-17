/**
 * @file CitationKeyStore.test.ts
 * @description Hermetic sqlite tests — every test uses its own tmp dir so DBs
 *   don't cross-contaminate. Covers:
 *   - put + get round-trip + origin round-trip
 *   - UNIQUE index enforced on citation_key
 *   - upsert overwrites an existing row (same itemKey, new key)
 *   - updateFromBbt: BBT key forcibly takes over a conflicting row
 *   - setUserOverride: same takeover, origin='user_override'
 *   - getAllExistingKeys returns the full key set
 *   - migrations are idempotent (reopening the same dir does not re-run them)
 *   - post-close calls throw
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/services/LoggerService', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { CitationKeyStore } from '../../../src/main/services/zotero/CitationKeyStore';

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citekey-store-'));
  return dir;
}

describe('CitationKeyStore', () => {
  let tmpDir: string;
  let store: CitationKeyStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new CitationKeyStore({ rootDir: tmpDir });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('put + get round-trip', () => {
    it('returns null for unseen itemKey', () => {
      expect(store.get('UNKNOWN')).toBeNull();
    });

    it('put then get returns the same record', () => {
      store.put('ITEM_A', 'smith2024deep', 'studio_mint');
      expect(store.get('ITEM_A')).toEqual({ key: 'smith2024deep', origin: 'studio_mint' });
    });

    it('put overwrites same itemKey with new key + origin', () => {
      store.put('ITEM_A', 'smith2024deep', 'studio_mint');
      store.put('ITEM_A', 'smith2024deepv2', 'user_override');
      expect(store.get('ITEM_A')).toEqual({
        key: 'smith2024deepv2',
        origin: 'user_override',
      });
    });

    it('put with empty itemKey throws', () => {
      expect(() => store.put('', 'key', 'studio_mint')).toThrow(/non-empty/);
    });

    it('put with empty key throws', () => {
      expect(() => store.put('ITEM_A', '', 'studio_mint')).toThrow(/non-empty/);
    });
  });

  describe('unique index on citation_key', () => {
    it('put a duplicate key for a different itemKey throws', () => {
      store.put('ITEM_A', 'smith2024deep', 'studio_mint');
      expect(() => store.put('ITEM_B', 'smith2024deep', 'studio_mint')).toThrow(/UNIQUE/);
    });
  });

  describe('getAllExistingKeys', () => {
    it('returns empty set on fresh store', () => {
      expect(store.getAllExistingKeys().size).toBe(0);
    });

    it('collects every currently-issued key', () => {
      store.put('A', 'smith2024deep', 'studio_mint');
      store.put('B', 'jones2024wide', 'studio_mint');
      store.put('C', 'lee2023auto', 'bbt');
      const keys = store.getAllExistingKeys();
      expect(keys.size).toBe(3);
      expect(keys.has('smith2024deep')).toBe(true);
      expect(keys.has('jones2024wide')).toBe(true);
      expect(keys.has('lee2023auto')).toBe(true);
    });
  });

  describe('updateFromBbt', () => {
    it('evicts a conflicting studio_mint holder and takes over the key', () => {
      // Studio minted `smith2024deep` for ITEM_A first
      store.put('ITEM_A', 'smith2024deep', 'studio_mint');
      // BBT later syncs and says: ITEM_B is the real owner of smith2024deep
      store.updateFromBbt('ITEM_B', 'smith2024deep');
      // ITEM_A is now free (its old key is orphaned; caller may re-mint)
      expect(store.get('ITEM_A')).toBeNull();
      // ITEM_B holds the key, origin=bbt
      expect(store.get('ITEM_B')).toEqual({ key: 'smith2024deep', origin: 'bbt' });
    });

    it('throws on empty arguments so callers cannot silently mis-use it', () => {
      store.put('A', 'x', 'studio_mint');
      expect(() => store.updateFromBbt('', 'foo')).toThrow(/non-empty/);
      expect(() => store.updateFromBbt('A', '')).toThrow(/non-empty/);
      // Prior state is untouched.
      expect(store.get('A')).toEqual({ key: 'x', origin: 'studio_mint' });
    });

    it('same itemKey → different bbtKey rewrites in place', () => {
      store.put('ITEM_A', 'smith2024deep', 'studio_mint');
      store.updateFromBbt('ITEM_A', 'smith2024real');
      expect(store.get('ITEM_A')).toEqual({ key: 'smith2024real', origin: 'bbt' });
      expect(store.getAllExistingKeys().has('smith2024deep')).toBe(false);
    });
  });

  describe('setUserOverride', () => {
    it('evicts a studio_mint holder and marks origin user_override', () => {
      store.put('ITEM_A', 'smith2024deep', 'studio_mint');
      store.setUserOverride('ITEM_B', 'smith2024deep');
      expect(store.get('ITEM_A')).toBeNull();
      expect(store.get('ITEM_B')).toEqual({ key: 'smith2024deep', origin: 'user_override' });
    });

    it('throws on empty arguments so callers cannot silently mis-use it', () => {
      expect(() => store.setUserOverride('', 'x')).toThrow(/non-empty/);
      expect(() => store.setUserOverride('A', '')).toThrow(/non-empty/);
      expect(store.getAllExistingKeys().size).toBe(0);
    });
  });

  describe('schema migrations', () => {
    it('reopens the same rootDir without re-running migrations', () => {
      store.put('ITEM_A', 'smith2024deep', 'studio_mint');
      store.close();
      const reopened = new CitationKeyStore({ rootDir: tmpDir });
      try {
        // Data survives reopen.
        expect(reopened.get('ITEM_A')).toEqual({ key: 'smith2024deep', origin: 'studio_mint' });
        // Idempotent: no duplicate table / no data loss on second boot.
        reopened.put('ITEM_B', 'jones2024wide', 'bbt');
        expect(reopened.getAllExistingKeys().size).toBe(2);
      } finally {
        reopened.close();
      }
    });
  });

  describe('lifecycle', () => {
    it('put after close throws', () => {
      store.close();
      expect(() => store.put('X', 'y', 'studio_mint')).toThrow(/closed/);
    });

    it('double close is safe', () => {
      store.close();
      expect(() => store.close()).not.toThrow();
    });

    it('get / getAllExistingKeys throw after close (assertOpen fully covers reads)', () => {
      store.close();
      expect(() => store.get('X')).toThrow(/closed/);
      expect(() => store.getAllExistingKeys()).toThrow(/closed/);
    });
  });
});
