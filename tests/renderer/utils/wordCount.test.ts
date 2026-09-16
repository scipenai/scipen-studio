/**
 * Unit tests for the word counter.
 *
 * The contract is "count what a reader sees": section titles and body prose
 * count, markup and math do not. Exactness is not claimed (a real LaTeX
 * parser is the only exact answer) — these lock the rules that matter.
 */

import { describe, expect, it } from 'vitest';
import { countWords, wordCountModeForFile } from '../../../src/renderer/src/utils/wordCount';

describe('countWords — plain text', () => {
  it('counts whitespace-separated words', () => {
    expect(countWords('one two three', 'plain').words).toBe(3);
  });

  it('ignores punctuation-only tokens', () => {
    expect(countWords('hello --- world', 'plain').words).toBe(2);
  });

  it('returns zero for empty input', () => {
    expect(countWords('', 'plain')).toEqual({ words: 0, characters: 0 });
  });

  it('counts characters excluding whitespace', () => {
    expect(countWords('ab cd', 'plain').characters).toBe(4);
  });
});

describe('countWords — LaTeX', () => {
  it('skips the preamble and counts only the document body', () => {
    const doc = [
      '\\documentclass{article}',
      '\\usepackage{amsmath}',
      '\\title{This Title Is In The Preamble}',
      '\\begin{document}',
      'Body words here.',
      '\\end{document}',
    ].join('\n');
    expect(countWords(doc, 'latex').words).toBe(3);
  });

  it('counts a fragment with no \\begin{document} as a whole', () => {
    // Chapter files pulled in via \input have no document environment.
    expect(countWords('Just three words', 'latex').words).toBe(3);
  });

  it('keeps prose arguments but drops identifier arguments', () => {
    const doc = '\\begin{document}\\section{Results}\\label{sec:results}Text.\\end{document}';
    // "Results" + "Text." — the label contributes nothing.
    expect(countWords(doc, 'latex').words).toBe(2);
  });

  it('drops citations and references', () => {
    const doc = '\\begin{document}As shown in \\cite{knuth1984} and \\ref{fig:one}.\\end{document}';
    expect(countWords(doc, 'latex').words).toBe(4); // As shown in and .
  });

  it('ignores comments but honours the \\% escape', () => {
    const doc = '\\begin{document}alpha % beta gamma\ndelta 50\\% done\\end{document}';
    // alpha, delta, 50, done — "beta gamma" is commented out.
    expect(countWords(doc, 'latex').words).toBe(4);
  });

  it('drops inline and display math', () => {
    const doc = '\\begin{document}Let $x = y$ then \\[ a + b = c \\] done.\\end{document}';
    expect(countWords(doc, 'latex').words).toBe(3); // Let / then / done.
  });

  it('drops math and verbatim environments wholesale', () => {
    const doc = [
      '\\begin{document}',
      'Before.',
      '\\begin{align}',
      'E = mc^2 \\\\ a = b',
      '\\end{align}',
      '\\begin{lstlisting}',
      'print("hello world this is code")',
      '\\end{lstlisting}',
      'After.',
      '\\end{document}',
    ].join('\n');
    expect(countWords(doc, 'latex').words).toBe(2);
  });

  it('unwraps nested text formatting', () => {
    const doc = '\\begin{document}\\textbf{\\emph{bold italic}} plain\\end{document}';
    expect(countWords(doc, 'latex').words).toBe(3);
  });

  it('counts CJK characters individually alongside Latin words', () => {
    const doc = '\\begin{document}本文提出一种方法 with two\\end{document}';
    // 8 CJK characters + "with" + "two"
    expect(countWords(doc, 'latex').words).toBe(10);
  });
});

describe('countWords — Typst', () => {
  it('drops set/show rules and code expressions', () => {
    const doc = ['#set page(width: 10cm)', '= Heading', 'Body text here.'].join('\n');
    expect(countWords(doc, 'typst').words).toBe(4); // Heading Body text here.
  });

  it('drops math and raw blocks', () => {
    const doc = 'Before $x + y$ after\n```\ncode goes here\n```\nend';
    expect(countWords(doc, 'typst').words).toBe(3); // Before after end
  });

  it('drops line and block comments', () => {
    expect(countWords('alpha // beta\n/* gamma */ delta', 'typst').words).toBe(2);
  });
});

describe('countWords — Markdown', () => {
  it('strips heading markers, emphasis and code', () => {
    const doc = ['# Title', 'Some **bold** text.', '`inline code`', '```', 'block', '```'].join(
      '\n'
    );
    expect(countWords(doc, 'markdown').words).toBe(4); // Title Some bold text.
  });

  it('keeps link text and drops the URL', () => {
    // see / the / paper / now — the href contributes nothing.
    expect(countWords('see [the paper](https://example.com/a/b) now', 'markdown').words).toBe(4);
  });
});

describe('wordCountModeForFile', () => {
  it('maps extensions to counting strategies', () => {
    expect(wordCountModeForFile('/p/main.tex')).toBe('latex');
    expect(wordCountModeForFile('/p/style.sty')).toBe('latex');
    expect(wordCountModeForFile('/p/main.typ')).toBe('typst');
    expect(wordCountModeForFile('/p/notes.md')).toBe('markdown');
    expect(wordCountModeForFile('/p/data.csv')).toBe('plain');
    expect(wordCountModeForFile(null)).toBe('plain');
  });
});
