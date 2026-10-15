/**
 * @file parseTeXLogErrors.test.ts — BusyTeX log error extraction
 * @description Guards the "exit 0 but log has errors" flip: BusyTeX's exit
 * code reflects xdvipdfmx (the last driver step), so a halted xelatex pass
 * with partial output reports success. These tests pin the parser against
 * real log excerpts (including the multi-pass duplication the driver's
 * rerun loop produces).
 * @depends vitest, CompilerProviders
 */

import { describe, expect, it } from 'vitest';
import { parseTeXLogErrors } from '../../../src/renderer/src/services/core/CompilerProviders';

const TIKZ_ERROR_LOG = [
  '$ xelatex -synctex=1 --interaction=batchmode --halt-on-error --no-pdf dijkstra-lecture.tex',
  "LaTeX Warning: Reference `eq:dy' on page 5 undefined on input line 268.",
  '',
  '! Package tikz Error: Cannot parse this coordinate.',
  '',
  'See the tikz package documentation for explanation.',
  'Type  H <return>  for immediate help.',
  ' ...                                              ',
  'l.326   \\draw (t) to[bend left] node[wl] {2} (y);',
  'Output written on dijkstra-lecture.xdv (4 pages, 67344 bytes).',
].join('\n');

describe('parseTeXLogErrors', () => {
  it('extracts a !-error with its l.<n> source line number', () => {
    const errors = parseTeXLogErrors(TIKZ_ERROR_LOG);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('! Package tikz Error: Cannot parse this coordinate.');
    expect(errors[0].line).toBe(326);
  });

  it('deduplicates identical errors logged across driver rerun passes', () => {
    const multiPass = [TIKZ_ERROR_LOG, TIKZ_ERROR_LOG, TIKZ_ERROR_LOG].join('\n');
    const errors = parseTeXLogErrors(multiPass);
    expect(errors).toHaveLength(1);
  });

  it("does not attribute the next error's line number", () => {
    const log = [
      '! Undefined control sequence.',
      '! Package tikz Error: Cannot parse this coordinate.',
      'l.326   \\draw (t) to (y);',
    ].join('\n');
    const errors = parseTeXLogErrors(log);
    expect(errors).toHaveLength(2);
    expect(errors[0].line).toBe(0); // own block ended at the next `!` — no line info
    expect(errors[1].line).toBe(326);
  });

  it('returns empty for a clean log (no false positives from warnings)', () => {
    const log = [
      "LaTeX Warning: Reference `x' undefined on input line 10.",
      'Overfull \\hbox (3.2pt too wide) detected at line 44',
      'Output written on doc.xdv (12 pages, 200000 bytes).',
    ].join('\n');
    expect(parseTeXLogErrors(log)).toHaveLength(0);
  });

  it('catches Fatal error lines that lack the ! prefix', () => {
    const log = ['xdvipdfmx:fatal: Could not open specified DVI file: doc.xdv'].join('\n');
    const errors = parseTeXLogErrors(log);
    expect(errors).toHaveLength(1);
    expect(errors[0].line).toBe(0);
  });
});
