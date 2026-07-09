import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mocks for the renderer SyncTeXService's collaborators ------------------
const readBinary = vi.fn();
const projectRef: { path: string | null } = { path: null };

vi.mock('@/api', () => ({
  api: { file: { readBinary: (p: string) => readBinary(p) } },
}));
vi.mock('@services/core/ServiceRegistry', () => ({
  getProjectService: () => ({ projectPath: projectRef.path }),
}));
vi.mock('@services/LogService', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { SyncTeXService } from '@services/SyncTeXService';

/** Minimal uncompressed .synctex with one page-1 box on source line 5. */
const synctexFor = (inputPath: string): ArrayBuffer =>
  new TextEncoder().encode(
    [
      `Input:1:${inputPath}`,
      'Content:',
      '{1',
      'h1,5:4736286,10000000:983040,400000,0',
      '}1',
      'Postamble:',
    ].join('\n')
  ).buffer as ArrayBuffer;

// A click well inside the single box (x≈72–87pt, y≈146–153pt).
const clickInBox = (svc: SyncTeXService) => svc.backward(1, 80, 150);

beforeEach(() => {
  readBinary.mockReset();
  projectRef.path = null;
});

describe('SyncTeXService.backward — host path mapping', () => {
  it('strips a "/./" segment from a recorded absolute path (avoids duplicate tab)', async () => {
    readBinary.mockResolvedValue(synctexFor('/proj/./main.tex'));
    const svc = new SyncTeXService();
    await svc.loadFromPath('/proj/main.synctex.gz');

    expect(clickInBox(svc)?.file).toBe('/proj/main.tex');
  });

  it('rebases a BusyTeX MEMFS path onto the open project root', async () => {
    projectRef.path = '/home/user/proj';
    readBinary.mockResolvedValue(synctexFor('/home/web_user/project_dir/chapters/intro.tex'));
    const svc = new SyncTeXService();
    await svc.loadFromPath('/home/user/proj/main.synctex.gz');

    expect(clickInBox(svc)?.file).toBe('/home/user/proj/chapters/intro.tex');
  });

  it('anchors a MEMFS path on the synctex dir when no project is open', async () => {
    readBinary.mockResolvedValue(synctexFor('/home/web_user/project_dir/main.tex'));
    const svc = new SyncTeXService();
    await svc.loadFromPath('/some/host/dir/main.synctex.gz');

    expect(clickInBox(svc)?.file).toBe('/some/host/dir/main.tex');
  });
});

describe('SyncTeXService.loadFromPath — race token', () => {
  it('is last-request-wins even when reads resolve out of order', async () => {
    let resolveA!: (v: ArrayBuffer) => void;
    const aPromise = new Promise<ArrayBuffer>((res) => {
      resolveA = res;
    });
    readBinary.mockImplementation((p: string) =>
      p === 'A.synctex.gz' ? aPromise : Promise.resolve(synctexFor('/proj/b.tex'))
    );

    const svc = new SyncTeXService();
    const pA = svc.loadFromPath('A.synctex.gz'); // requested first, resolves last
    const pB = svc.loadFromPath('B.synctex.gz');
    await pB; // B installs

    resolveA(synctexFor('/proj/a.tex'));
    await pA; // A resolves late and must be dropped

    expect(clickInBox(svc)?.file).toBe('/proj/b.tex');
  });

  it('a no-op idempotent reload does not cancel an in-flight load of a new path', async () => {
    // Preload X.
    readBinary.mockResolvedValueOnce(synctexFor('/proj/x.tex'));
    const svc = new SyncTeXService();
    await svc.loadFromPath('X.synctex.gz');

    // Start a load of a NEW path Y that stays pending.
    let resolveY!: (v: ArrayBuffer) => void;
    const yPromise = new Promise<ArrayBuffer>((res) => {
      resolveY = res;
    });
    readBinary.mockImplementation((p: string) =>
      p === 'Y.synctex.gz' ? yPromise : Promise.resolve(synctexFor('/proj/x.tex'))
    );
    const pY = svc.loadFromPath('Y.synctex.gz');

    // A no-op reload of the already-loaded X must NOT bump the token and drop Y.
    await svc.loadFromPath('X.synctex.gz');

    resolveY(synctexFor('/proj/y.tex'));
    await pY;

    expect(clickInBox(svc)?.file).toBe('/proj/y.tex');
  });
});

describe('SyncTeXService — availability', () => {
  it('isAvailable() tracks load / clear', async () => {
    readBinary.mockResolvedValue(synctexFor('/proj/main.tex'));
    const svc = new SyncTeXService();
    expect(svc.isAvailable()).toBe(false);
    await svc.loadFromPath('/proj/main.synctex.gz');
    expect(svc.isAvailable()).toBe(true);
    svc.clear();
    expect(svc.isAvailable()).toBe(false);
  });

  it('clear() on a failed read leaves sync unavailable', async () => {
    readBinary.mockRejectedValue(new Error('boom'));
    const svc = new SyncTeXService();
    await svc.loadFromPath('/proj/main.synctex.gz');
    expect(svc.isAvailable()).toBe(false);
  });
});
