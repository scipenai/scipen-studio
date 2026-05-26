/**
 * @file CiteCompletionProvider.test.ts —— 锁定 LaTeX/Markdown/Typst 三种触发位置
 *   的 prefix 提取和 rangeStart 列号计算。Monaco 本体不 mock —— 重点是 regex
 *   边界 + 多 key brace 内的分段计算。
 */

import { describe, expect, it } from 'vitest';
import { _internal } from '../../../src/renderer/src/components/editor/CiteCompletionProvider';

/** 用 jsdom 风格的 model stub:仅提供 getValueInRange 拿光标前的子串。 */
function modelStub(lineContent: string) {
  return {
    getValueInRange: (range: {
      startLineNumber: number;
      startColumn: number;
      endLineNumber: number;
      endColumn: number;
    }) => lineContent.slice(range.startColumn - 1, range.endColumn - 1),
  } as unknown as Parameters<typeof _internal.detectContext>[0];
}

describe('detectContext —— LaTeX', () => {
  it('triggers right after \\cite{', () => {
    const line = '\\cite{';
    const ctx = _internal.detectContext(modelStub(line), pos(line.length + 1), 'latex');
    expect(ctx?.prefix).toBe('');
    expect(ctx?.rangeStart).toBe(line.length + 1);
  });

  it('captures the running prefix in \\cite{smit', () => {
    const line = '\\cite{smit';
    const ctx = _internal.detectContext(modelStub(line), pos(line.length + 1), 'latex');
    expect(ctx?.prefix).toBe('smit');
    expect(ctx?.rangeStart).toBe(line.length + 1 - 4);
  });

  it('handles multi-key brace \\cite{a, b, c', () => {
    const line = '\\cite{a, b, c';
    const ctx = _internal.detectContext(modelStub(line), pos(line.length + 1), 'latex');
    expect(ctx?.prefix).toBe('c');
    expect(ctx?.rangeStart).toBe(line.length + 1 - 1);
  });

  it('handles \\citep[args]{key variants', () => {
    const line = '\\citep[ch.~3]{jone';
    const ctx = _internal.detectContext(modelStub(line), pos(line.length + 1), 'latex');
    expect(ctx?.prefix).toBe('jone');
  });

  it('returns null when not in cite context', () => {
    expect(
      _internal.detectContext(modelStub('plain text '), pos(12), 'latex')
    ).toBeNull();
  });
});

describe('detectContext —— Markdown', () => {
  it('triggers on [@ prefix', () => {
    const line = '... see [@smith';
    const ctx = _internal.detectContext(modelStub(line), pos(line.length + 1), 'markdown');
    expect(ctx?.prefix).toBe('smith');
  });

  it('falls back to bare @key (pandoc, no brackets)', () => {
    const line = 'see @jone';
    const ctx = _internal.detectContext(modelStub(line), pos(line.length + 1), 'markdown');
    expect(ctx?.prefix).toBe('jone');
  });

  it('still recognises LaTeX \\cite inside markdown', () => {
    const line = 'see \\cite{thom';
    const ctx = _internal.detectContext(modelStub(line), pos(line.length + 1), 'markdown');
    expect(ctx?.prefix).toBe('thom');
  });
});

describe('detectContext —— Typst', () => {
  it('triggers on @key', () => {
    const line = 'Refer to @carai';
    const ctx = _internal.detectContext(modelStub(line), pos(line.length + 1), 'typst');
    expect(ctx?.prefix).toBe('carai');
  });

  it('triggers as soon as @x is typed (completion is greedier than hover)', () => {
    const line = '@a';
    const ctx = _internal.detectContext(modelStub(line), pos(line.length + 1), 'typst');
    expect(ctx?.prefix).toBe('a');
  });

  it('rejects bare @ with no char yet', () => {
    const line = '@';
    const ctx = _internal.detectContext(modelStub(line), pos(line.length + 1), 'typst');
    expect(ctx).toBeNull();
  });
});

function pos(column: number) {
  return { lineNumber: 1, column } as unknown as Parameters<
    typeof _internal.detectContext
  >[1];
}
