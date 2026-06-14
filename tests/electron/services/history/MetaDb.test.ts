/**
 * @file MetaDb migration runner tests.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MetaDb, MIGRATIONS, createMetaDb } from '../../../../src/main/services/history/MetaDb';

let tmpRoot: string;
let metaDb: MetaDb;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scipen-metadb-'));
});

afterEach(async () => {
  if (metaDb) metaDb.close();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('MetaDb', () => {
  it('runs every migration on first open and reports the version', () => {
    metaDb = createMetaDb({ rootDir: tmpRoot });
    const expected = Math.max(...MIGRATIONS.map((m) => m.version));
    expect(metaDb.schemaVersion()).toBe(expected);
  });

  it('opens with WAL journal mode', () => {
    metaDb = createMetaDb({ rootDir: tmpRoot });
    const mode = metaDb.db.pragma('journal_mode', { simple: true });
    expect(mode).toBe('wal');
  });

  it('enables foreign_keys', () => {
    metaDb = createMetaDb({ rootDir: tmpRoot });
    const fk = metaDb.db.pragma('foreign_keys', { simple: true });
    expect(fk).toBe(1);
  });

  it('creates the seven history tables', () => {
    metaDb = createMetaDb({ rootDir: tmpRoot });
    const names = metaDb.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: unknown) => (r as { name: string }).name);
    for (const t of [
      'history_blob',
      'history_chunk',
      'history_label',
      'history_label_file',
      'history_session',
      'history_step',
      'history_step_file',
    ]) {
      expect(names).toContain(t);
    }
  });

  it('records each applied migration in schema_migration', () => {
    metaDb = createMetaDb({ rootDir: tmpRoot });
    const rows = metaDb.db
      .prepare('SELECT version, description FROM schema_migration ORDER BY version')
      .all() as Array<{ version: number; description: string }>;
    expect(rows.length).toBe(MIGRATIONS.length);
    for (let i = 0; i < MIGRATIONS.length; i++) {
      expect(rows[i].version).toBe(MIGRATIONS[i].version);
      expect(rows[i].description).toBe(MIGRATIONS[i].description);
    }
  });

  it('is idempotent on second open (no duplicate migration applied)', () => {
    metaDb = createMetaDb({ rootDir: tmpRoot });
    metaDb.close();
    metaDb = createMetaDb({ rootDir: tmpRoot });
    const count = (
      metaDb.db.prepare('SELECT COUNT(*) AS c FROM schema_migration').get() as { c: number }
    ).c;
    expect(count).toBe(MIGRATIONS.length);
  });

  it('history_blob has STRICT typing — text into INTEGER refcount rejects', () => {
    metaDb = createMetaDb({ rootDir: tmpRoot });
    const insert = metaDb.db.prepare(
      'INSERT INTO history_blob (hash, size, refcount, created_at) VALUES (?, 1, ?, 0)'
    );
    expect(() => insert.run(new Uint8Array([1, 2, 3]), 'not-an-int')).toThrow();
  });
});
