/**
 * @file ZoteroFullTextService.test.ts
 * @description Unit tests for tier-1 PDF full-text extraction + global cache.
 *   Mocks fs (stat/readFile/mkdir/writeFile), pdf-parse, and the Zotero
 *   data-dir resolver; injects a fake LocalApiClient for attachment lookup.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/services/LoggerService', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mocks = vi.hoisted(() => ({
  stat: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
  pdfParse: vi.fn(),
  resolveDataDir: vi.fn(async () => '/zotero-data'),
}));

vi.mock('fs', () => {
  const promises = {
    stat: mocks.stat,
    readFile: mocks.readFile,
    readdir: mocks.readdir,
    mkdir: mocks.mkdir,
    writeFile: mocks.writeFile,
  };
  return { promises, default: { promises } };
});

vi.mock('pdf-parse', () => ({ default: mocks.pdfParse }));

vi.mock('../../../src/main/services/zotero/ZoteroDiscoveryService', () => ({
  resolveZoteroDataDir: mocks.resolveDataDir,
}));

import * as path from 'path';
import type { ZoteroAttachmentDTO } from '../../../shared/types/zotero';
import { ZoteroFullTextService } from '../../../src/main/services/zotero/ZoteroFullTextService';
import type { ZoteroLocalApiClient } from '../../../src/main/services/zotero/ZoteroLocalApiClient';

function makeApi(attachments: ZoteroAttachmentDTO[]): ZoteroLocalApiClient {
  return {
    getItemAttachments: vi.fn(async () => attachments),
  } as unknown as ZoteroLocalApiClient;
}

const PDF_ATTACHMENT: ZoteroAttachmentDTO = {
  itemKey: 'ATTACH01',
  contentType: 'application/pdf',
  filename: 'paper.pdf',
  linkMode: 'imported_file',
};

describe('ZoteroFullTextService', () => {
  beforeEach(() => {
    mocks.stat.mockReset();
    mocks.readFile.mockReset();
    // 默认 reject —— getFullText 开头会先读 parsed/full.md(MinerU 档),
    // 未显式 mock 时视为「无 MinerU 缓存」,落回 local 流程。
    mocks.readFile.mockRejectedValue(new Error('default miss'));
    mocks.readdir.mockReset();
    mocks.mkdir.mockClear();
    mocks.writeFile.mockClear();
    mocks.pdfParse.mockReset();
    mocks.resolveDataDir.mockReset();
    mocks.resolveDataDir.mockResolvedValue('/zotero-data');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns tier:none when item has no PDF attachment', async () => {
    const svc = new ZoteroFullTextService(makeApi([]));
    const res = await svc.getFullText('ITEM1');
    expect(res).toEqual({ text: '', truncated: false, tier: 'none' });
    expect(mocks.pdfParse).not.toHaveBeenCalled();
  });

  it('extracts + caches on miss (tier:local)', async () => {
    mocks.stat.mockResolvedValue({ mtimeMs: 1000, size: 500 }); // pdf stat
    mocks.readFile
      .mockRejectedValueOnce(new Error('no mineru')) // parsed/full.md → 无 mineru 档
      .mockRejectedValueOnce(new Error('no meta')) // meta.json read → cache miss
      .mockResolvedValueOnce(Buffer.from('%PDF-fake')); // pdf bytes
    mocks.pdfParse.mockResolvedValue({ text: 'Full paper body.' });

    const svc = new ZoteroFullTextService(makeApi([PDF_ATTACHMENT]));
    const res = await svc.getFullText('ITEM1');

    expect(res.tier).toBe('local');
    expect(res.text).toBe('Full paper body.');
    expect(res.truncated).toBe(false);
    // cache written
    expect(mocks.writeFile).toHaveBeenCalledTimes(2); // content.txt + meta.json
  });

  it('serves from cache when PDF unchanged (skips pdf-parse)', async () => {
    mocks.stat.mockResolvedValue({ mtimeMs: 1000, size: 500 });
    const meta = JSON.stringify({
      // path.join 跨平台:Windows 下是反斜杠,必须用 join 而非硬编码正斜杠。
      pdfPath: path.join('/zotero-data', 'storage', 'ATTACH01', 'paper.pdf'),
      pdfMtimeMs: 1000,
      pdfSize: 500,
      extractedAt: '2026-01-01T00:00:00.000Z',
    });
    mocks.readFile
      .mockRejectedValueOnce(new Error('no mineru')) // parsed/full.md → 无 mineru 档
      .mockResolvedValueOnce(meta) // meta.json
      .mockResolvedValueOnce('Cached body.'); // content.txt

    const svc = new ZoteroFullTextService(makeApi([PDF_ATTACHMENT]));
    const res = await svc.getFullText('ITEM1');

    expect(res).toEqual({ text: 'Cached body.', truncated: false, tier: 'local', quality: 'good' });
    expect(mocks.pdfParse).not.toHaveBeenCalled();
  });

  it('re-extracts when PDF mtime changed (cache stale)', async () => {
    mocks.stat.mockResolvedValue({ mtimeMs: 2000, size: 500 }); // newer mtime
    const staleMeta = JSON.stringify({
      pdfPath: '/zotero-data/storage/ATTACH01/paper.pdf',
      pdfMtimeMs: 1000, // old
      pdfSize: 500,
      extractedAt: '2026-01-01T00:00:00.000Z',
    });
    mocks.readFile
      .mockRejectedValueOnce(new Error('no mineru')) // parsed/full.md → 无 mineru 档
      .mockResolvedValueOnce(staleMeta) // meta.json → stale
      .mockResolvedValueOnce(Buffer.from('%PDF-new')); // pdf bytes
    mocks.pdfParse.mockResolvedValue({ text: 'New body.' });

    const svc = new ZoteroFullTextService(makeApi([PDF_ATTACHMENT]));
    const res = await svc.getFullText('ITEM1');

    expect(res.text).toBe('New body.');
    expect(mocks.pdfParse).toHaveBeenCalledOnce();
  });

  it('truncates oversized text + flags truncated', async () => {
    mocks.stat.mockResolvedValue({ mtimeMs: 1, size: 9 });
    mocks.readFile
      .mockRejectedValueOnce(new Error('no mineru'))
      .mockRejectedValueOnce(new Error('no meta'))
      .mockResolvedValueOnce(Buffer.from('%PDF'));
    // 300KB text > 200KB cap
    mocks.pdfParse.mockResolvedValue({ text: 'x'.repeat(300 * 1024) });

    const svc = new ZoteroFullTextService(makeApi([PDF_ATTACHMENT]));
    const res = await svc.getFullText('ITEM1');

    expect(res.truncated).toBe(true);
    expect(res.text.endsWith('[...truncated]')).toBe(true);
  });

  it('resolves linked_file path directly (no storage dir)', async () => {
    const linked: ZoteroAttachmentDTO = {
      itemKey: 'ATTACH02',
      contentType: 'application/pdf',
      linkMode: 'linked_file',
      path: '/abs/linked/paper.pdf',
    };
    mocks.stat.mockResolvedValue({ mtimeMs: 1, size: 9 });
    mocks.readFile
      .mockRejectedValueOnce(new Error('no mineru'))
      .mockRejectedValueOnce(new Error('no meta'))
      .mockResolvedValueOnce(Buffer.from('%PDF'));
    mocks.pdfParse.mockResolvedValue({ text: 'Linked body.' });

    const svc = new ZoteroFullTextService(makeApi([linked]));
    const res = await svc.getFullText('ITEM1');

    expect(res.text).toBe('Linked body.');
    expect(mocks.stat).toHaveBeenCalledWith('/abs/linked/paper.pdf');
    expect(mocks.resolveDataDir).not.toHaveBeenCalled();
  });

  it('serves tier:mineru when parsed/full.md exists (skips pdf-parse + attachments)', async () => {
    // 第一次 readFile(parsed/full.md)成功 → 直接走 mineru 档,不碰 PDF。
    mocks.readFile.mockReset();
    mocks.readFile.mockResolvedValueOnce('# Parsed\n\nStructured body.');

    const svc = new ZoteroFullTextService(makeApi([PDF_ATTACHMENT]));
    const res = await svc.getFullText('ITEM1');

    expect(res.tier).toBe('mineru');
    expect(res.text).toBe('# Parsed\n\nStructured body.');
    expect(mocks.pdfParse).not.toHaveBeenCalled();
    expect(mocks.stat).not.toHaveBeenCalled();
  });

  it('flags quality:poor when extraction is garbled', async () => {
    mocks.stat.mockResolvedValue({ mtimeMs: 1, size: 9 });
    mocks.readFile
      .mockRejectedValueOnce(new Error('no mineru'))
      .mockRejectedValueOnce(new Error('no meta'))
      .mockResolvedValueOnce(Buffer.from('%PDF'));
    // 替换符占多数 = 字体无 ToUnicode 的真乱码。
    mocks.pdfParse.mockResolvedValue({ text: '����� abc' });

    const svc = new ZoteroFullTextService(makeApi([PDF_ATTACHMENT]));
    const res = await svc.getFullText('ITEM1');

    expect(res.tier).toBe('local');
    expect(res.quality).toBe('poor');
  });

  describe('getContentList', () => {
    it('reads the UUID-prefixed *_content_list.json', async () => {
      mocks.readdir.mockResolvedValue(['full.md', 'abc-123_content_list.json', 'images']);
      const list = [{ type: 'text', text: 'Body', page_idx: 0 }];
      mocks.readFile.mockReset();
      mocks.readFile.mockResolvedValueOnce(JSON.stringify(list));

      const svc = new ZoteroFullTextService(makeApi([]));
      const res = await svc.getContentList('ITEM1');

      expect(res).toEqual(list);
    });

    it('returns null when no content_list file exists', async () => {
      mocks.readdir.mockResolvedValue(['full.md', 'images']);
      const svc = new ZoteroFullTextService(makeApi([]));
      expect(await svc.getContentList('ITEM1')).toBeNull();
      expect(mocks.readFile).not.toHaveBeenCalled();
    });

    it('returns null when the parsed dir is missing (readdir throws)', async () => {
      mocks.readdir.mockRejectedValue(new Error('ENOENT'));
      const svc = new ZoteroFullTextService(makeApi([]));
      expect(await svc.getContentList('ITEM1')).toBeNull();
    });

    it('returns null on corrupt JSON / non-array payload', async () => {
      mocks.readdir.mockResolvedValue(['x_content_list.json']);
      mocks.readFile.mockReset();
      mocks.readFile.mockResolvedValueOnce('{not json');
      const svc = new ZoteroFullTextService(makeApi([]));
      expect(await svc.getContentList('ITEM1')).toBeNull();

      mocks.readFile.mockReset();
      mocks.readFile.mockResolvedValueOnce('{"foo":1}'); // valid JSON, not array
      expect(await svc.getContentList('ITEM1')).toBeNull();
    });
  });
});
