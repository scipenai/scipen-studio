import { describe, expect, it } from 'vitest';
import { isGuaranteedRemoteMiss } from '../../../src/main/busytex-process/remoteFetch';

describe('isGuaranteedRemoteMiss', () => {
  it('matches TeX build artifact extensions on the pinned TeX Live 2026 snapshot', () => {
    const exts = ['aux', 'toc', 'out', 'bbl', 'blg', 'xdv', 'pdf', 'bcf', 'run.xml', 'synctex.gz'];
    for (const ext of exts) {
      expect(
        isGuaranteedRemoteMiss(`https://texlive2026.texlyre.org/26/main.${ext}`),
        `expected miss for .${ext}`
      ).toBe(true);
    }
  });

  it('matches bundled Fandol .fontspec probes and snapshot-absent cfg/cm probes on default host', () => {
    const urls = [
      'https://texlive2026.texlyre.org/26/FandolSong-Regular.fontspec',
      'https://texlive2026.texlyre.org/26/FandolSong-Bold.fontspec',
      'https://texlive2026.texlyre.org/26/FandolHei-Regular.fontspec',
      'https://texlive2026.texlyre.org/26/FandolHei-Bold.fontspec',
      'https://texlive2026.texlyre.org/26/FandolKai-Regular.fontspec',
      'https://texlive2026.texlyre.org/26/FandolFang-Regular.fontspec',
      'https://texlive2026.texlyre.org:443/26/hyperref.cfg',
      'https://texlive2026.texlyre.org/26/rerunfilecheck.cfg',
      'https://texlive2026.texlyre.org/26/gettitlestring.cfg',
      'https://texlive2026.texlyre.org/26/pd1enc.dfu',
      'https://texlive2026.texlyre.org/26/puenc.dfu',
      'https://texlive2026.texlyre.org/20/cmr10.ofm',
      'https://texlive2026.texlyre.org/33/cmr10.vf',
      'https://texlive2026.texlyre.org/39/cmr10',
      'https://texlive2026.texlyre.org/45/cmmi10',
    ];
    for (const url of urls) {
      expect(isGuaranteedRemoteMiss(url), `expected miss for ${url}`).toBe(true);
    }
  });

  it('never short-circuits custom mirrors, HTTP origins, or non-default ports', () => {
    const customMirrorUrls = [
      'https://custom-mirror.example.com/26/hyperref.cfg',
      'https://custom-mirror.example.com/26/pd1enc.dfu',
      'https://custom-mirror.example.com/26/FandolSong-Regular.fontspec',
      'https://custom-mirror.example.com/26/main.aux',
      'https://custom-mirror.example.com/20/cmr10.ofm',
      'https://custom-mirror.example.com/33/cmr10.vf',
      'https://custom-mirror.example.com/39/cmr10',
      'https://custom-mirror.example.com/45/cmmi10',
      'http://127.0.0.1:8080/26/hyperref.cfg',
      'http://texlive2026.texlyre.org/26/hyperref.cfg',
      'https://texlive2026.texlyre.org:8443/26/hyperref.cfg',
    ];
    for (const url of customMirrorUrls) {
      expect(isGuaranteedRemoteMiss(url), `must not skip ${url}`).toBe(false);
    }
  });

  it('returns false for real TeX packages, fonts, and unknown URLs', () => {
    expect(isGuaranteedRemoteMiss('https://texlive2026.texlyre.org/26/tikz.sty')).toBe(false);
    expect(isGuaranteedRemoteMiss('https://texlive2026.texlyre.org/26/ctex.sty')).toBe(false);
    expect(
      isGuaranteedRemoteMiss('https://texlive2026.texlyre.org/47/FandolSong-Regular.otf')
    ).toBe(false);
    expect(isGuaranteedRemoteMiss('https://example.invalid/missing.sty')).toBe(false);
    expect(isGuaranteedRemoteMiss('scipen-wasm://busytex/texlive-basic.js')).toBe(false);
    expect(isGuaranteedRemoteMiss('not-a-url')).toBe(false);
  });
});
