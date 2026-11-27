/**
 * Unit tests for TexliveRemoteCache — the disk cache behind the
 * `scipen-wasm://texlive-remote/` proxy (see WasmAssetProtocol).
 *
 * The module is deliberately Electron-free (pure node:fs/path/crypto), so
 * these run as plain filesystem tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TexliveRemoteCache, DEFAULT_MAX_BYTES } from '@main/services/TexliveRemoteCache';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

describe('TexliveRemoteCache', () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texlive-cache-test-'));
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  const makeCache = (maxBytes?: number) => new TexliveRemoteCache({ cacheDir, maxBytes });

  it('returns null for an unknown URL', async () => {
    const cache = makeCache();
    expect(await cache.get('https://mirror.example/x/font.otf')).toBeNull();
    expect(cache.stats.hits).toBe(0);
  });

  it('stores and serves a 200 body round-trip', async () => {
    const cache = makeCache();
    const url = 'https://mirror.example/tex/latex/ctex/ctex.sty';
    const body = Buffer.from('\\ProvidesPackage{ctex}');
    await cache.put(url, body);

    const entry = await cache.get(url);
    expect(entry).not.toBeNull();
    expect(entry!.status).toBe(200);
    expect(entry!.body!.equals(body)).toBe(true);
    expect(cache.stats.stores).toBe(1);
    expect(cache.stats.hits).toBe(1);
    expect(cache.stats.bytesServed).toBe(body.byteLength);
  });

  it('stores a 404 miss marker and serves it as a miss hit', async () => {
    const cache = makeCache();
    const url = 'https://mirror.example/tex/latex/nonexistent.sty';
    await cache.putMiss(url);

    const entry = await cache.get(url);
    expect(entry).not.toBeNull();
    expect(entry!.status).toBe(404);
    expect(entry!.body).toBeNull();
    expect(cache.stats.missStores).toBe(1);
    expect(cache.stats.missHits).toBe(1);
  });

  it('serves 404 misses regardless of age — they never expire', async () => {
    // Inverted from an earlier "expires after 7 days" test, kept as the
    // anchor for that decision: the endpoint is an immutable snapshot, so a
    // miss stays true, and expiring them cost a multi-minute re-probe storm
    // (hundreds of serial curl round-trips) on a fixed weekly cadence.
    const cache = makeCache();
    const url = 'https://mirror.example/tex/latex/late.sty';
    await cache.putMiss(url);

    const past = new Date(Date.now() - SEVEN_DAYS_MS - 1000);
    const marker = fs.readdirSync(cacheDir).find((f) => f.endsWith('.miss'))!;
    fs.utimesSync(path.join(cacheDir, marker), past, past);

    expect((await cache.get(url))!.status).toBe(404);
    // And the marker survives — nothing re-probes it.
    expect(fs.readdirSync(cacheDir).some((f) => f.endsWith('.miss'))).toBe(true);
  });

  it('keeps different URLs in separate key spaces', async () => {
    const cache = makeCache();
    await cache.put('https://mirror-a.example/tex/font.otf', Buffer.from('A'));
    await cache.put('https://mirror-b.example/tex/font.otf', Buffer.from('B'));

    const a = await cache.get('https://mirror-a.example/tex/font.otf');
    const b = await cache.get('https://mirror-b.example/tex/font.otf');
    expect(a!.body!.toString()).toBe('A');
    expect(b!.body!.toString()).toBe('B');
  });

  it('evicts least-recently-used entries when maxBytes is exceeded', async () => {
    // Each body ~100 bytes; cap at 250 → only ~2 entries fit.
    const cache = makeCache(250);
    const mkBody = (n: number) => Buffer.alloc(100, n);

    await cache.put('https://m.example/one', mkBody(1));
    await new Promise((r) => setTimeout(r, 20)); // distinct mtime ordering
    await cache.put('https://m.example/two', mkBody(2));
    await new Promise((r) => setTimeout(r, 20));
    await cache.put('https://m.example/three', mkBody(3));

    // 'one' is the oldest → evicted; the two newest survive.
    expect(await cache.get('https://m.example/one')).toBeNull();
    expect((await cache.get('https://m.example/two'))!.status).toBe(200);
    expect((await cache.get('https://m.example/three'))!.status).toBe(200);
  }, 15000);

  it('touching an entry on get protects it from eviction', async () => {
    const cache = makeCache(250);
    await cache.put('https://m.example/old', Buffer.alloc(100, 1));
    await new Promise((r) => setTimeout(r, 20));
    await cache.put('https://m.example/mid', Buffer.alloc(100, 2));
    await new Promise((r) => setTimeout(r, 20));
    // Read 'old' → its mtime refreshes past 'mid'.
    await cache.get('https://m.example/old');
    await new Promise((r) => setTimeout(r, 20));
    await cache.put('https://m.example/new', Buffer.alloc(100, 3));

    expect((await cache.get('https://m.example/old'))!.status).toBe(200);
    expect(await cache.get('https://m.example/mid')).toBeNull();
    expect((await cache.get('https://m.example/new'))!.status).toBe(200);
  }, 15000);

  it('never throws on unreadable cache state — get degrades to null', async () => {
    const cache = makeCache();
    const url = 'https://m.example/corrupt';
    await cache.put(url, Buffer.from('data'));
    // Corrupt: replace the content file with a directory — readFile now fails.
    const bin = fs.readdirSync(cacheDir).find((f) => f.endsWith('.bin'))!;
    fs.rmSync(path.join(cacheDir, bin));
    fs.mkdirSync(path.join(cacheDir, bin));

    expect(await cache.get(url)).toBeNull();
  });

  it('exports the documented defaults', () => {
    expect(DEFAULT_MAX_BYTES).toBe(1024 * 1024 * 1024);
  });

  it('a failed LRU touch does not discard an otherwise valid hit', async () => {
    const cache = makeCache();
    const url = 'https://m.example/touch-fails';
    await cache.put(url, Buffer.from('payload'));

    const original = fs.utimesSync;
    (fs as { utimesSync: unknown }).utimesSync = () => {
      throw new Error('EPERM');
    };
    try {
      // The touch is decorative bookkeeping; it must not veto the payload.
      expect((await cache.get(url))!.body!.toString()).toBe('payload');
    } finally {
      (fs as { utimesSync: unknown }).utimesSync = original;
    }
  });

  it('keeps .miss markers out of LRU eviction', async () => {
    // Misses are zero-byte, so evicting them reclaims nothing — and their
    // mtime is never refreshed, which used to sort them first and wipe the
    // entire miss set for no gain.
    const cache = makeCache(250);
    for (let i = 0; i < 20; i += 1) await cache.putMiss(`https://m.example/missing-${i}`);
    await cache.put('https://m.example/one', Buffer.alloc(100, 1));
    await new Promise((r) => setTimeout(r, 20));
    await cache.put('https://m.example/two', Buffer.alloc(100, 2));
    await new Promise((r) => setTimeout(r, 20));
    await cache.put('https://m.example/three', Buffer.alloc(100, 3));

    expect(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.miss'))).toHaveLength(20);
    // Eviction still converges on the .bin entries despite the miss majority.
    expect(await cache.get('https://m.example/one')).toBeNull();
    expect((await cache.get('https://m.example/three'))!.status).toBe(200);
  }, 15000);

  it('reports usage with counts and bytes separated', async () => {
    const cache = makeCache();
    await cache.put('https://m.example/pkg', Buffer.alloc(120, 7));
    await cache.putMiss('https://m.example/nope');

    const usage = cache.usage();
    expect(usage).toEqual({ binCount: 1, binBytes: 120, missCount: 1 });
  });

  it('clearMisses drops only the markers, never payloads or in-flight files', async () => {
    const cache = makeCache();
    await cache.put('https://m.example/keep', Buffer.from('payload'));
    await cache.putMiss('https://m.example/drop-a');
    await cache.putMiss('https://m.example/drop-b');

    // Transfer files live in this same directory. Deleting a live `.fetch-*`
    // makes the engine read back an empty body and cache it as a permanent
    // 200, so bulk operations must match entry names strictly.
    const key = 'a'.repeat(64);
    const staleTmp = path.join(cacheDir, `${key}.bin.1234.abcd.tmp`);
    const inFlight = path.join(cacheDir, '.fetch-1234-abcd');
    const foreign = path.join(cacheDir, 'README.txt');
    fs.writeFileSync(staleTmp, 'partial');
    fs.writeFileSync(inFlight, 'downloading');
    fs.writeFileSync(foreign, 'notes');

    expect(cache.clearMisses()).toEqual({ removed: 2 });

    expect(fs.existsSync(staleTmp)).toBe(true);
    expect(fs.existsSync(inFlight)).toBe(true);
    expect(fs.existsSync(foreign)).toBe(true);
    expect((await cache.get('https://m.example/keep'))!.body!.toString()).toBe('payload');
    expect(fs.readdirSync(cacheDir).some((f) => f.endsWith('.miss'))).toBe(false);
  });

  it('clearMisses and usage degrade quietly when the directory is absent', () => {
    const cache = new TexliveRemoteCache({ cacheDir: path.join(cacheDir, 'not-created-yet') });
    expect(cache.usage()).toEqual({ binCount: 0, binBytes: 0, missCount: 0 });
    expect(cache.clearMisses()).toEqual({ removed: 0 });
  });
});
