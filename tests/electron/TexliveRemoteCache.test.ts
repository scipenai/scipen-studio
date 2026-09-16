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
import {
  TexliveRemoteCache,
  DEFAULT_MAX_BYTES,
  MISS_TTL_MS,
} from '@main/services/TexliveRemoteCache';

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

  it('expires 404 misses after MISS_TTL_MS so late-added files are re-consulted', async () => {
    const cache = makeCache();
    const url = 'https://mirror.example/tex/latex/late.sty';
    await cache.putMiss(url);

    // Backdate the marker past the TTL.
    const past = new Date(Date.now() - MISS_TTL_MS - 1000);
    const marker = fs.readdirSync(cacheDir).find((f) => f.endsWith('.miss'))!;
    fs.utimesSync(path.join(cacheDir, marker), past, past);

    expect(await cache.get(url)).toBeNull();
    // The expired marker is cleaned up.
    expect(fs.readdirSync(cacheDir).some((f) => f.endsWith('.miss'))).toBe(false);
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
    expect(MISS_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
