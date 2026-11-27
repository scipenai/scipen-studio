/**
 * Tests for `Project_CreateFromTemplate` atomic staging, error codes,
 * localized dialog title forwarding, and Zod schema validation.
 */

import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcChannel } from '../../../shared/ipc/channels';
import type { ProjectCreateFromTemplateResult } from '../../../shared/ipc/file-contract';

const mocks = vi.hoisted(() => ({
  resourcesDir: '',
  showOpenDialog: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  setProjectPath: vi.fn(),
  authorizePathsTemporarily: vi.fn(),
  buildFileTree: vi.fn(),
  startWatching: vi.fn(),
  addRecentProject: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => mocks.resourcesDir,
    getPath: (name: string) => path.join(mocks.resourcesDir || os.tmpdir(), `user-${name}`),
  },
  dialog: {
    showOpenDialog: mocks.showOpenDialog,
  },
}));

vi.mock('../../../src/main/services/LocalFileProtocol', () => ({
  addAllowedDirectory: vi.fn(),
  clearAllowedDirectories: vi.fn(),
}));

vi.mock('../../../src/main/services/zotero/BibTexSyncService', () => ({
  getBibTexSyncService: () => ({ setProjectPath: vi.fn() }),
}));

vi.mock('../../../src/main/ipc/typedIpc', () => ({
  createTypedHandlers: (map: Record<string, (...args: unknown[]) => unknown>) => {
    mocks.handlers.clear();
    for (const [channel, fn] of Object.entries(map)) {
      mocks.handlers.set(channel, fn);
    }
    return { registerAll: vi.fn() };
  },
}));

vi.mock('../../../src/main/ipc/fileHandlerHelpers', () => ({
  PathSecurityService: {
    setProjectPath: mocks.setProjectPath,
    authorizePathsTemporarily: mocks.authorizePathsTemporarily,
  },
  assertPathSecurity: (p: string) => p,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  resolveProjectOpenRoot: async (p: string) => p,
}));

import { registerFileTreeHandlers } from '../../../src/main/ipc/fileTreeHandlers';
import { channelSchemas } from '../../../src/main/ipc/ipcSchemas';

type CreateHandler = (
  templateId: string,
  projectName: string,
  dialogTitle?: string
) => Promise<ProjectCreateFromTemplateResult>;

let tmpRoot: string;
let parentDir: string;
let fakeWindow: object | null;

function getCreateHandler(): CreateHandler {
  registerFileTreeHandlers({
    fileSystemService: {
      buildFileTree: mocks.buildFileTree,
      startWatching: mocks.startWatching,
      on: vi.fn(),
    } as never,
    getMainWindow: () => fakeWindow as never,
    getWindows: () => new Map(),
    addRecentProject: mocks.addRecentProject,
    loadRecentProjects: async () => [],
  });
  const handler = mocks.handlers.get(IpcChannel.Project_CreateFromTemplate);
  if (!handler) {
    throw new Error('Project_CreateFromTemplate handler not registered');
  }
  return handler as CreateHandler;
}

describe('Project_CreateFromTemplate', () => {
  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scipen-tpl-create-'));
    parentDir = path.join(tmpRoot, 'projects');
    await fs.ensureDir(parentDir);

    const templatesDir = path.join(tmpRoot, 'resources', 'templates');
    const articleDir = path.join(templatesDir, 'article');
    await fs.ensureDir(articleDir);
    await fs.writeFile(path.join(articleDir, 'main.tex'), '\\documentclass{article}\n');
    await fs.writeFile(path.join(articleDir, 'refs.bib'), '@article{a, title={A}}\n');
    await fs.writeJson(path.join(templatesDir, 'manifest.json'), {
      version: 1,
      templates: [{ id: 'article', mainFile: 'main.tex', engine: 'latex', offline: true }],
    });

    mocks.resourcesDir = tmpRoot;
    fakeWindow = { id: 1 };
    mocks.showOpenDialog.mockReset();
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [parentDir] });
    mocks.buildFileTree.mockReset();
    mocks.buildFileTree.mockResolvedValue({ name: 'my-paper', path: '', type: 'directory' });
    mocks.startWatching.mockReset();
    mocks.addRecentProject.mockReset();
    mocks.addRecentProject.mockResolvedValue(undefined);
    mocks.setProjectPath.mockReset();
    mocks.authorizePathsTemporarily.mockReset();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.remove(tmpRoot);
  });

  it('passes localized dialogTitle and leaves no staging temp dir on success', async () => {
    const handler = getCreateHandler();
    const res = await handler('article', 'my-paper', 'Custom Title');

    expect(mocks.showOpenDialog).toHaveBeenCalledWith(fakeWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Custom Title',
    });
    expect(res.ok).toBe(true);
    const projectPath = path.join(parentDir, 'my-paper');
    expect(await fs.pathExists(path.join(projectPath, 'main.tex'))).toBe(true);
    expect(await fs.pathExists(path.join(projectPath, 'refs.bib'))).toBe(true);
    expect(await fs.readdir(parentDir)).toEqual(['my-paper']);
  });

  it('omits dialog title when dialogTitle is undefined or blank', async () => {
    const handler = getCreateHandler();
    await handler('article', 'my-paper', '   ');

    expect(mocks.showOpenDialog).toHaveBeenCalledWith(fakeWindow, {
      properties: ['openDirectory', 'createDirectory'],
    });
  });

  it('cleans up partial staging directory on mid-copy failure so retry succeeds', async () => {
    const handler = getCreateHandler();
    const origCopy = fs.copy.bind(fs);
    vi.spyOn(fs, 'copy').mockImplementationOnce(async (_src, dest) => {
      await fs.ensureDir(String(dest));
      await fs.writeFile(path.join(String(dest), 'main.tex'), 'partial');
      throw new Error('disk full');
    });

    const failed = await handler('article', 'my-paper', 'Select Folder');
    expect(failed).toEqual({
      ok: false,
      errorCode: 'copyFailed',
      error: 'disk full',
    });

    const projectPath = path.join(parentDir, 'my-paper');
    expect(await fs.pathExists(projectPath)).toBe(false);
    expect(await fs.readdir(parentDir)).toEqual([]);

    vi.spyOn(fs, 'copy').mockImplementation(origCopy);
    const retried = await handler('article', 'my-paper', 'Select Folder');
    expect(retried.ok).toBe(true);
    expect(await fs.pathExists(path.join(projectPath, 'main.tex'))).toBe(true);
    expect(await fs.readdir(parentDir)).toEqual(['my-paper']);
  });

  it('returns structured error codes for validation and missing template failures', async () => {
    const handler = getCreateHandler();

    fakeWindow = null;
    expect(await handler('article', 'my-paper')).toMatchObject({
      ok: false,
      errorCode: 'noWindow',
    });
    fakeWindow = { id: 1 };

    expect(await handler('nonexistent', 'my-paper')).toMatchObject({
      ok: false,
      errorCode: 'unknownTemplate',
    });

    await fs.remove(path.join(tmpRoot, 'resources', 'templates', 'article'));
    expect(await handler('article', 'my-paper')).toMatchObject({
      ok: false,
      errorCode: 'templateFilesMissing',
    });

    await fs.ensureDir(path.join(tmpRoot, 'resources', 'templates', 'article'));
    await fs.ensureDir(path.join(parentDir, 'my-paper'));
    expect(await handler('article', 'my-paper')).toMatchObject({
      ok: false,
      errorCode: 'alreadyExists',
    });

    expect(await handler('article', '../escape')).toMatchObject({
      ok: false,
      errorCode: 'invalidProjectName',
    });
  });

  it('validates Project_CreateFromTemplate tuple with and without optional dialogTitle', () => {
    const schema = channelSchemas.get(IpcChannel.Project_CreateFromTemplate);
    expect(schema).toBeDefined();
    expect(schema!.safeParse(['article', 'my-paper']).success).toBe(true);
    expect(schema!.safeParse(['article', 'my-paper', undefined]).success).toBe(true);
    expect(schema!.safeParse(['article', 'my-paper', 'Choose folder']).success).toBe(true);
    expect(schema!.safeParse(['article', 'my-paper', '']).success).toBe(false);
  });
});
