/**
 * @file citationKeyScan.test.ts
 * @description Pure helper tests for citation key detection. The regex math
 *   under `extractKeyAt` is the part that has gone wrong in past iterations,
 *   so cover it directly (Monaco itself is heavy and buys little to mock).
 */

import { describe, expect, it } from 'vitest';
import { _internal } from '../../../src/renderer/src/components/editor/citationKeyScan';

describe('citationKeyScan.extractKeyAt', () => {
  function runMatch(line: string): RegExpExecArray {
    const re = /\\cite[a-zA-Z]*\*?\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
    const m = re.exec(line);
    if (!m) throw new Error(`No \\cite match in: ${line}`);
    return m;
  }

  it('returns the single key inside a one-key brace', () => {
    const line = '\\cite{smith2024}';
    const m = runMatch(line);
    // cursor on the 's' of smith2024 (col 7 zero-based)
    expect(_internal.extractKeyAt(m, 7)).toBe('smith2024');
  });

  it('returns the key at the cursor in a multi-key brace', () => {
    const line = '\\cite{a,bbbb,ccc}';
    const m = runMatch(line);
    // 'a' = col 6; 'bbbb' = 8-11; 'ccc' = 13-15
    expect(_internal.extractKeyAt(m, 6)).toBe('a');
    expect(_internal.extractKeyAt(m, 9)).toBe('bbbb');
    expect(_internal.extractKeyAt(m, 14)).toBe('ccc');
  });

  it('returns null when the cursor is on the command text rather than inside braces', () => {
    const line = '\\cite{smith}';
    const m = runMatch(line);
    expect(_internal.extractKeyAt(m, 2)).toBe(null);
  });

  it('handles optional-argument variants \\cite[ch.~3]{key}', () => {
    const line = '\\cite[ch.~3]{textbook}';
    const m = runMatch(line);
    const braceStart = line.indexOf('{') + 1;
    expect(_internal.extractKeyAt(m, braceStart + 2)).toBe('textbook');
  });
});
