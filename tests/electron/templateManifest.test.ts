/**
 * Tests for the bundled-template manifest reader.
 *
 * The reader is deliberately total: a corrupt or partially-written manifest
 * must degrade to "no templates offered" rather than breaking the welcome
 * screen, and malformed entries must be dropped individually instead of
 * poisoning the whole list.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

const appState = vi.hoisted(() => ({ resourcesDir: '' }));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => appState.resourcesDir,
  },
  dialog: { showOpenDialog: vi.fn() },
}));

// The handler module drags in the full main-process graph; stub the parts the
// manifest reader never touches.
vi.mock('../../src/main/services/LocalFileProtocol', () => ({
  addAllowedDirectory: vi.fn(),
  clearAllowedDirectories: vi.fn(),
}));
vi.mock('../../src/main/services/zotero/BibTexSyncService', () => ({
  getBibTexSyncService: () => ({ setProjectPath: vi.fn() }),
}));
vi.mock('../../src/main/ipc/typedIpc', () => ({ createTypedHandlers: vi.fn() }));
vi.mock('../../src/main/ipc/fileHandlerHelpers', () => ({
  PathSecurityService: { setProjectPath: vi.fn(), authorizePathsTemporarily: vi.fn() },
  assertPathSecurity: (p: string) => p,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  resolveProjectOpenRoot: async (p: string) => p,
}));

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scipen-templates-'));
  appState.resourcesDir = tmpRoot;
  await fs.ensureDir(path.join(tmpRoot, 'resources', 'templates'));
  vi.resetModules();
});

afterEach(async () => {
  await fs.remove(tmpRoot);
});

async function writeManifest(content: string): Promise<void> {
  await fs.writeFile(path.join(tmpRoot, 'resources', 'templates', 'manifest.json'), content);
}

/** Reach the non-exported reader through the module's registration surface. */
async function readTemplates(): Promise<unknown[]> {
  const mod = await import('../../src/main/ipc/fileTreeHandlers');
  const internal = mod as unknown as {
    __readTemplateManifestForTests?: () => Promise<unknown[]>;
  };
  if (!internal.__readTemplateManifestForTests) {
    throw new Error('test hook missing');
  }
  return internal.__readTemplateManifestForTests();
}

describe('template manifest reader', () => {
  it('parses well-formed entries', async () => {
    await writeManifest(
      JSON.stringify({
        version: 1,
        templates: [
          { id: 'article', dir: 'article', mainFile: 'main.tex', engine: 'latex', offline: true },
          { id: 'slides', dir: 'slides', mainFile: 'talk.typ', engine: 'typst', offline: false },
        ],
      })
    );
    const templates = await readTemplates();
    expect(templates).toEqual([
      { id: 'article', mainFile: 'main.tex', engine: 'latex', offline: true },
      { id: 'slides', mainFile: 'talk.typ', engine: 'typst', offline: false },
    ]);
  });

  it('defaults engine to latex and offline to true when omitted', async () => {
    await writeManifest(JSON.stringify({ templates: [{ id: 'x', mainFile: 'main.tex' }] }));
    expect(await readTemplates()).toEqual([
      { id: 'x', mainFile: 'main.tex', engine: 'latex', offline: true },
    ]);
  });

  it('drops entries missing an id or mainFile instead of failing the list', async () => {
    await writeManifest(
      JSON.stringify({
        templates: [
          { id: 'good', mainFile: 'main.tex' },
          { id: 'no-main' },
          { mainFile: 'orphan.tex' },
        ],
      })
    );
    const templates = await readTemplates();
    expect(templates).toHaveLength(1);
    expect((templates[0] as { id: string }).id).toBe('good');
  });

  it('returns an empty list when the manifest is missing', async () => {
    expect(await readTemplates()).toEqual([]);
  });

  it('returns an empty list when the manifest is not valid JSON', async () => {
    await writeManifest('{ this is not json');
    expect(await readTemplates()).toEqual([]);
  });

  it('returns an empty list when `templates` is not an array', async () => {
    await writeManifest(JSON.stringify({ templates: { id: 'nope' } }));
    expect(await readTemplates()).toEqual([]);
  });
});
