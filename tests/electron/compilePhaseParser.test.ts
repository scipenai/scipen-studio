/**
 * Unit tests for compilePhaseParser — turns BusyTeX worker `{print}` lines
 * into structured CompileProgressPayload phase events for the UI.
 *
 * Reference lines mirror what `busytex_pipeline.js` / emscripten actually
 * print (command lines, `Preparing... (n/m)`, package lists).
 */

import { describe, it, expect } from 'vitest';
import {
  createBusyTexPhaseState,
  parseBusyTexPrintLine,
} from '../../src/main/services/compilePhaseParser';

describe('compilePhaseParser', () => {
  it('counts typesetting engine commands as numbered passes', () => {
    const state = createBusyTexPhaseState();

    const p1 = parseBusyTexPrintLine(
      '$ busytex xelatex -synctex=1 --no-shell-escape --fmt /texlive/xelatex.fmt main.tex',
      state
    );
    expect(p1).toEqual({
      engine: 'latex',
      stage: 'pass',
      message: 'Running xelatex (pass 1)',
      passIndex: 1,
    });

    const p2 = parseBusyTexPrintLine('$ busytex xelatex -synctex=1 main.tex', state);
    expect(p2?.passIndex).toBe(2);
    expect(p2?.stage).toBe('pass');
  });

  it('recognizes all four typesetting programs as passes', () => {
    for (const program of ['pdflatex', 'xelatex', 'lualatex', 'luahblatex']) {
      const state = createBusyTexPhaseState();
      const phase = parseBusyTexPrintLine(`$ busytex ${program} main.tex`, state);
      expect(phase?.stage).toBe('pass');
    }
  });

  it('classifies bibtex8 / makeindex / xdvipdfmx as postprocess without touching passIndex', () => {
    const state = createBusyTexPhaseState();
    parseBusyTexPrintLine('$ busytex pdflatex main.tex', state); // pass 1

    const bib = parseBusyTexPrintLine('$ busytex bibtex8 --8bit main.aux', state);
    expect(bib).toMatchObject({ stage: 'postprocess', message: 'Running bibtex8' });
    expect(bib).not.toHaveProperty('passIndex');

    const idx = parseBusyTexPrintLine('$ busytex makeindex main.idx', state);
    expect(idx?.stage).toBe('postprocess');

    const dvi = parseBusyTexPrintLine('$ busytex xdvipdfmx -o main.pdf main.xdv', state);
    expect(dvi?.stage).toBe('postprocess');

    // Postprocess runs must not advance the pass counter.
    const next = parseBusyTexPrintLine('$ busytex pdflatex main.tex', state);
    expect(next?.passIndex).toBe(2);
  });

  it('parses emscripten Preparing lines into engine-load percent', () => {
    const state = createBusyTexPhaseState();
    const phase = parseBusyTexPrintLine('Preparing... (3/7)', state);
    expect(phase).toMatchObject({
      stage: 'engine-load',
      message: 'Preparing... (3/7)',
      percent: 43,
    });
    expect(parseBusyTexPrintLine('Preparing... (7/7)', state)?.percent).toBe(100);
  });

  it('turns the compilation-start marker into a staging phase', () => {
    const state = createBusyTexPhaseState();
    expect(parseBusyTexPrintLine('New compilation started: [main.tex]', state)).toEqual({
      engine: 'latex',
      stage: 'staging',
      message: 'Compiling [main.tex]',
    });
  });

  it('surfaces the resolved TeX package list as staging', () => {
    const state = createBusyTexPhaseState();
    const phase = parseBusyTexPrintLine('TeX packages: [amsmath, ctex]', state);
    expect(phase).toMatchObject({ stage: 'staging', message: 'TeX packages: amsmath, ctex' });

    // Empty package list stays presentable instead of printing stray brackets.
    expect(parseBusyTexPrintLine('TeX packages: []', state)?.message).toBe('TeX packages: none');
  });

  it('returns null for non-phase chatter', () => {
    const state = createBusyTexPhaseState();
    const chatter = [
      '',
      '   ',
      '$ echo $?',
      '0',
      'TeX packages local: [article]',
      'TeX packages unresolved (in local or preloaded): [ctex]',
      'Data packages used (preloaded): [texlive-basic.js]',
      'Some random kpathsea output',
    ];
    for (const line of chatter) {
      expect(parseBusyTexPrintLine(line, state)).toBeNull();
    }
  });

  it('keeps the pass counter independent per state instance', () => {
    const a = createBusyTexPhaseState();
    const b = createBusyTexPhaseState();
    parseBusyTexPrintLine('$ busytex pdflatex main.tex', a);
    parseBusyTexPrintLine('$ busytex pdflatex main.tex', a);
    expect(parseBusyTexPrintLine('$ busytex pdflatex main.tex', b)?.passIndex).toBe(1);
  });
});
