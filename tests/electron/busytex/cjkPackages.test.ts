import { describe, expect, it } from 'vitest';
import { CJK_PACKAGE_URL, needsCjkPackage } from '../../../src/main/busytex-process/cjkPackages';

describe('needsCjkPackage', () => {
  it('exports the expected scipen-wasm CJK package URL', () => {
    expect(CJK_PACKAGE_URL).toBe('scipen-wasm://busytex/texlive-cjk.js');
  });

  it('detects ctex, xeCJK, and zhnumber packages across TeX source extensions', () => {
    expect(
      needsCjkPackage([
        {
          path: 'main.tex',
          contents: '\\documentclass{article}\n\\usepackage[fontset=fandol]{ctex}\n',
        },
      ])
    ).toBe(true);

    expect(
      needsCjkPackage([
        { path: 'main.tex', contents: '\\documentclass{article}\n\\usepackage{xeCJK}\n' },
      ])
    ).toBe(true);

    expect(
      needsCjkPackage([
        { path: 'main.tex', contents: '\\documentclass{article}\n\\usepackage{zhnumber}\n' },
      ])
    ).toBe(true);
  });

  it('detects ctex document classes and custom class/style files', () => {
    expect(needsCjkPackage([{ path: 'main.tex', contents: '\\documentclass{ctexart}\n' }])).toBe(
      true
    );
    expect(
      needsCjkPackage([
        { path: 'book.tex', contents: '\\documentclass[fontset=fandol]{ctexbook}\n' },
      ])
    ).toBe(true);
    expect(
      needsCjkPackage([{ path: 'slides.tex', contents: '\\documentclass{ctexbeamer}\n' }])
    ).toBe(true);
    expect(needsCjkPackage([{ path: 'custom.cls', contents: '\\LoadClass{ctexbook}\n' }])).toBe(
      true
    );
    expect(needsCjkPackage([{ path: 'macros.sty', contents: '\\RequirePackage{xeCJK}\n' }])).toBe(
      true
    );
  });

  it('ignores commented-out directives while respecting escaped percents', () => {
    expect(
      needsCjkPackage([
        {
          path: 'main.tex',
          contents:
            '\\documentclass{article}\n% \\usepackage{ctex}\n\\begin{document}Hi\\end{document}\n',
        },
      ])
    ).toBe(false);

    expect(
      needsCjkPackage([
        {
          path: 'main.tex',
          contents:
            '\\documentclass{article}\n% note: 50\\% done\n\\begin{document}\n100\\% \\usepackage{xeCJK}\n\\end{document}\n',
        },
      ])
    ).toBe(true);

    expect(
      needsCjkPackage([
        {
          path: 'main.tex',
          contents: '\\documentclass{article}\n100\\% complete % \\usepackage{ctex}\n',
        },
      ])
    ).toBe(false);
  });

  it('returns false for plain English documents and binary figures', () => {
    expect(
      needsCjkPackage([
        {
          path: 'main.tex',
          contents:
            '\\documentclass{article}\n\\usepackage{amsmath, amssymb}\n\\begin{document}Hello\\end{document}\n',
        },
        {
          path: 'fig.png',
          contents: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        },
        {
          path: 'notes.txt',
          contents: '\\usepackage{ctex}',
        },
      ])
    ).toBe(false);
  });
});
