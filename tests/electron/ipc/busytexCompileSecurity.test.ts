/**
 * Regression tests for BusyTeX IPC path security in `compileHandlers.ts`.
 *
 * Ensures `Compile_BusyTeX_Compile` unconditionally validates `outputDir`,
 * `mainFileAbs`, and `overlay.absPath` before forwarding any request to the
 * BusyTeX utility process, even when `projectRoot` is omitted or fails checks.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcChannel } from '../../../shared/ipc/channels';
import type { BusyTeXCompileRequestDTO } from '../../../shared/ipc/compile-contract';

const mocks = vi.hoisted(() => ({
  compile: vi.fn(),
  onPhase: vi.fn(() => ({ dispose: vi.fn() })),
  kill: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
  app: {
    isPackaged: false,
    getAppPath: () => os.tmpdir(),
    getPath: (name: string) => path.join(os.tmpdir(), `scipen-test-${name}`),
  },
}));

vi.mock('../../../src/main/services/BusyTexProcessClient', () => ({
  BUSYTEX_STOPPED_MESSAGE: 'BusyTeX compile cancelled',
  getBusyTexProcessClient: () => ({
    compile: mocks.compile,
    onPhase: mocks.onPhase,
    kill: mocks.kill,
    ensureLoaded: vi.fn(),
  }),
}));

vi.mock('../../../src/main/services/WasmAssetProtocol', () => ({
  probeTexliveEndpoint: vi.fn(),
  resolveTexliveCacheDir: () => path.join(os.tmpdir(), 'scipen-test-texlive-cache'),
  resolveWasmRoot: () => path.join(os.tmpdir(), 'scipen-test-wasm'),
}));

vi.mock('../../../src/main/services/TexliveRemoteCache', () => ({
  TexliveRemoteCache: vi.fn(),
}));

vi.mock('../../../src/main/services/compiler/CompilerRegistry', () => ({
  CompilerRegistry: { get: vi.fn() },
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

import { registerCompileHandlers } from '../../../src/main/ipc/compileHandlers';
import { PathSecurityService } from '../../../src/main/services/PathSecurityService';

type BusyTexCompileHandler = (request: BusyTeXCompileRequestDTO) => Promise<{
  success: boolean;
  log: string;
  errors: string[];
}>;

const BASE_ROOT = path.join(os.tmpdir(), 'scipen-busytex-sec-suite');
const PROJECT_ROOT = path.join(BASE_ROOT, 'project-a');
const EXTERNAL_DIR = path.join(BASE_ROOT, 'external-dir');
const MAIN_TEX = path.join(PROJECT_ROOT, 'main.tex');
const SENSITIVE_SYSTEM_DIR =
  process.platform === 'win32' ? 'C:\\Windows\\System32\\spool' : '/etc/busytex-out';

function makeRequest(overrides: Partial<BusyTeXCompileRequestDTO> = {}): BusyTeXCompileRequestDTO {
  return {
    projectRoot: PROJECT_ROOT,
    mainFileAbs: MAIN_TEX,
    overlay: { absPath: MAIN_TEX, contents: '\\documentclass{article}' },
    driver: 'pdftex',
    endpoint: '',
    outputDir: PROJECT_ROOT,
    baseName: 'main',
    ...overrides,
  };
}

function getBusyTexHandler(): BusyTexCompileHandler {
  registerCompileHandlers();
  const handler = mocks.handlers.get(IpcChannel.Compile_BusyTeX_Compile);
  if (!handler) {
    throw new Error('Compile_BusyTeX_Compile handler not registered');
  }
  return handler as BusyTexCompileHandler;
}

describe('Compile_BusyTeX_Compile path security', () => {
  beforeEach(() => {
    mocks.compile.mockReset();
    mocks.compile.mockResolvedValue({
      exitCode: 0,
      pdfPath: path.join(PROJECT_ROOT, 'main.pdf'),
      synctexPath: path.join(PROJECT_ROOT, 'main.synctex.gz'),
      log: 'ok',
    });
    PathSecurityService.setProjectPath(null);
    PathSecurityService.clearAllAuthorizations();
  });

  afterEach(() => {
    PathSecurityService.setProjectPath(null);
    PathSecurityService.clearAllAuthorizations();
  });

  it('rejects outputDir when no project is open and projectRoot is omitted', async () => {
    const handler = getBusyTexHandler();
    const res = await handler(makeRequest({ projectRoot: undefined, outputDir: EXTERNAL_DIR }));

    expect(res.success).toBe(false);
    expect(res.errors[0]).toMatch(/No active project/i);
    expect(mocks.compile).not.toHaveBeenCalled();
  });

  it('rejects outputDir outside active project when projectRoot is omitted', async () => {
    PathSecurityService.setProjectPath(PROJECT_ROOT);
    const handler = getBusyTexHandler();

    const res = await handler(makeRequest({ projectRoot: undefined, outputDir: EXTERNAL_DIR }));

    expect(res.success).toBe(false);
    expect(res.errors[0]).toMatch(/outside the project directory/i);
    expect(mocks.compile).not.toHaveBeenCalled();
  });

  it('rejects outputDir outside active project when an external projectRoot is stripped', async () => {
    PathSecurityService.setProjectPath(PROJECT_ROOT);
    const handler = getBusyTexHandler();

    const res = await handler(makeRequest({ projectRoot: EXTERNAL_DIR, outputDir: EXTERNAL_DIR }));

    expect(res.success).toBe(false);
    expect(res.errors[0]).toMatch(/outside the project directory/i);
    expect(mocks.compile).not.toHaveBeenCalled();
  });

  it('rejects protected system or traversal paths in outputDir even when projectRoot is omitted', async () => {
    PathSecurityService.setProjectPath(PROJECT_ROOT);
    const handler = getBusyTexHandler();

    const sysRes = await handler(
      makeRequest({ projectRoot: undefined, outputDir: SENSITIVE_SYSTEM_DIR })
    );
    expect(sysRes.success).toBe(false);
    expect(sysRes.errors[0]).toMatch(/protected system path/i);

    const traversalRes = await handler(
      makeRequest({
        projectRoot: undefined,
        outputDir: `${PROJECT_ROOT}${path.sep}..${path.sep}outside`,
      })
    );
    expect(traversalRes.success).toBe(false);
    expect(traversalRes.errors[0]).toMatch(/traversal/i);
    expect(mocks.compile).not.toHaveBeenCalled();
  });

  it('rejects traversal and sensitive paths in mainFileAbs and overlay.absPath', async () => {
    PathSecurityService.setProjectPath(PROJECT_ROOT);
    const handler = getBusyTexHandler();

    const badMain = await handler(
      makeRequest({
        projectRoot: undefined,
        mainFileAbs: `${PROJECT_ROOT}${path.sep}..${path.sep}secret.tex`,
      })
    );
    expect(badMain.success).toBe(false);
    expect(badMain.errors[0]).toMatch(/traversal/i);

    const badOverlay = await handler(
      makeRequest({
        projectRoot: undefined,
        overlay: {
          absPath: path.join(PROJECT_ROOT, '.ssh', 'id_rsa'),
          contents: 'x',
        },
      })
    );
    expect(badOverlay.success).toBe(false);
    expect(mocks.compile).not.toHaveBeenCalled();
  });

  it('keeps strict project containment for outputDir when projectRoot is active', async () => {
    PathSecurityService.setProjectPath(PROJECT_ROOT);
    PathSecurityService.authorizePathTemporarily(EXTERNAL_DIR);
    const handler = getBusyTexHandler();

    const res = await handler(makeRequest({ outputDir: EXTERNAL_DIR }));

    expect(res.success).toBe(false);
    expect(res.errors[0]).toMatch(/outside the project/i);
    expect(mocks.compile).not.toHaveBeenCalled();
  });

  it('forwards sanitized paths when outputDir and inputs are within active project', async () => {
    PathSecurityService.setProjectPath(PROJECT_ROOT);
    const handler = getBusyTexHandler();

    const subDir = path.join(PROJECT_ROOT, 'sub', 'build');
    const res = await handler(
      makeRequest({
        projectRoot: undefined,
        outputDir: `${PROJECT_ROOT}${path.sep}sub${path.sep}.${path.sep}build`,
      })
    );

    expect(res.success).toBe(true);
    expect(mocks.compile).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: undefined,
        mainFileAbs: path.normalize(MAIN_TEX),
        overlay: { absPath: path.normalize(MAIN_TEX), contents: '\\documentclass{article}' },
        outputDir: path.normalize(subDir),
      })
    );
  });
});

describe('Compile_BusyTeX_Compile symlink and junction containment', () => {
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  let tmpRoot: string;
  let realProjectDir: string;
  let realOutsideDir: string;
  let realMainTex: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scipen-busytex-link-sec-'));
    realProjectDir = path.join(tmpRoot, 'project');
    realOutsideDir = path.join(tmpRoot, 'outside');
    realMainTex = path.join(realProjectDir, 'main.tex');
    fs.mkdirSync(realProjectDir, { recursive: true });
    fs.mkdirSync(realOutsideDir, { recursive: true });
    fs.writeFileSync(realMainTex, '\\documentclass{article}\n');

    mocks.compile.mockReset();
    mocks.compile.mockResolvedValue({
      exitCode: 0,
      pdfPath: path.join(realProjectDir, 'main.pdf'),
      synctexPath: path.join(realProjectDir, 'main.synctex.gz'),
      log: 'ok',
    });
    PathSecurityService.setProjectPath(realProjectDir);
    PathSecurityService.clearAllAuthorizations();
  });

  afterEach(() => {
    PathSecurityService.setProjectPath(null);
    PathSecurityService.clearAllAuthorizations();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('rejects symlink or junction outputDir pointing outside the project even with projectRoot omitted', async () => {
    const buildLink = path.join(realProjectDir, 'build-link');
    fs.symlinkSync(realOutsideDir, buildLink, linkType);
    const handler = getBusyTexHandler();

    const withRoot = await handler(
      makeRequest({
        projectRoot: realProjectDir,
        mainFileAbs: realMainTex,
        overlay: { absPath: realMainTex, contents: '\\documentclass{article}' },
        outputDir: buildLink,
      })
    );
    expect(withRoot.success).toBe(false);
    expect(withRoot.errors[0]).toMatch(/outside the project/i);

    const withoutRoot = await handler(
      makeRequest({
        projectRoot: undefined,
        mainFileAbs: realMainTex,
        overlay: { absPath: realMainTex, contents: '\\documentclass{article}' },
        outputDir: buildLink,
      })
    );
    expect(withoutRoot.success).toBe(false);
    expect(withoutRoot.errors[0]).toMatch(/outside the project/i);
    expect(mocks.compile).not.toHaveBeenCalled();
  });

  it('rejects non-existent subdirectories nested under an escaping symlink or junction', async () => {
    const buildLink = path.join(realProjectDir, 'build-link');
    fs.symlinkSync(realOutsideDir, buildLink, linkType);
    const handler = getBusyTexHandler();

    const res = await handler(
      makeRequest({
        projectRoot: realProjectDir,
        mainFileAbs: realMainTex,
        overlay: { absPath: realMainTex, contents: '\\documentclass{article}' },
        outputDir: path.join(buildLink, 'nested', 'sub'),
      })
    );

    expect(res.success).toBe(false);
    expect(res.errors[0]).toMatch(/outside the project/i);
    expect(mocks.compile).not.toHaveBeenCalled();
  });

  it('rejects a dangling symlink or junction in outputDir that targets outside the project', async () => {
    const danglingLink = path.join(realProjectDir, 'dangling-link');
    fs.symlinkSync(path.join(realOutsideDir, 'missing-dir'), danglingLink, linkType);
    const handler = getBusyTexHandler();

    const res = await handler(
      makeRequest({
        projectRoot: realProjectDir,
        mainFileAbs: realMainTex,
        overlay: { absPath: realMainTex, contents: '\\documentclass{article}' },
        outputDir: danglingLink,
      })
    );

    expect(res.success).toBe(false);
    expect(res.errors[0]).toMatch(/outside the project/i);
    expect(mocks.compile).not.toHaveBeenCalled();
  });

  it('forwards outputSandboxRoot when outputDir is genuinely inside the project', async () => {
    const handler = getBusyTexHandler();
    const res = await handler(
      makeRequest({
        projectRoot: realProjectDir,
        mainFileAbs: realMainTex,
        overlay: { absPath: realMainTex, contents: '\\documentclass{article}' },
        outputDir: realProjectDir,
      })
    );

    expect(res.success).toBe(true);
    expect(mocks.compile).toHaveBeenCalledWith(
      expect.objectContaining({
        outputDir: path.normalize(realProjectDir),
        outputSandboxRoot: path.normalize(realProjectDir),
      })
    );
  });

  it('rejects a pre-planted output artifact file symlink pointing outside the project when supported', async () => {
    const victimFile = path.join(realOutsideDir, 'victim.txt');
    const plantedPdfLink = path.join(realProjectDir, 'main.pdf');
    fs.writeFileSync(victimFile, 'keep-safe');

    try {
      fs.symlinkSync(victimFile, plantedPdfLink, 'file');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === 'EPERM' || code === 'EACCES') {
        return;
      }
      throw err;
    }

    const handler = getBusyTexHandler();
    const res = await handler(
      makeRequest({
        projectRoot: realProjectDir,
        mainFileAbs: realMainTex,
        overlay: { absPath: realMainTex, contents: '\\documentclass{article}' },
        outputDir: realProjectDir,
      })
    );

    expect(res.success).toBe(false);
    expect(res.errors[0]).toMatch(/outside the project/i);
    expect(mocks.compile).not.toHaveBeenCalled();
  });
});
