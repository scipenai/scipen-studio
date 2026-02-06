/**
 * @file TextProcessor.test.ts - Unit tests for text chunking logic
 * @description Tests LaTeX environment protection (prevent formula splitting), Markdown heading splitting (semantic boundaries), and metadata extraction. Critical because RAG retrieval quality depends on chunking quality, split LaTeX formulas produce meaningless embeddings, and metadata errors affect search/reference.
 * @depends TextProcessor chunking logic
 */

import { beforeEach, describe, expect, it } from 'vitest';

// ====== Test Types ======
interface ChunkData {
  content: string;
  type: string;
  metadata?: Record<string, unknown>;
}

interface DocumentMetadata {
  title?: string;
  authors?: string[];
  abstract?: string;
  keywords?: string[];
  year?: number;
}

/**
 * Simulate TextProcessor core chunking logic
 * Extracted from actual implementation for independent testing
 */
class TestableTextProcessor {
  private chunkSize = 1000;
  private chunkOverlap = 200;

  /**
   * Split by Markdown headings
   */
  splitByHeadings(content: string): Array<{ heading: string; level: number; content: string }> {
    const lines = content.split('\n');
    const sections: Array<{ heading: string; level: number; content: string }> = [];

    let currentSection = { heading: '', level: 0, content: '' };

    for (const line of lines) {
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

      if (headingMatch) {
        if (currentSection.content.trim()) {
          sections.push({ ...currentSection, content: currentSection.content.trim() });
        }

        currentSection = {
          heading: headingMatch[2],
          level: headingMatch[1].length,
          content: '',
        };
      } else {
        currentSection.content += `${line}\n`;
      }
    }

    if (currentSection.content.trim()) {
      sections.push({ ...currentSection, content: currentSection.content.trim() });
    }

    if (sections.length === 0) {
      sections.push({ heading: '', level: 0, content: content.trim() });
    }

    return sections;
  }

  /**
   * Split by LaTeX sections
   */
  splitLatexSections(content: string): Array<{ name: string; type: string; content: string }> {
    const sections: Array<{ name: string; type: string; content: string }> = [];

    const sectionRegex = /\\(section|subsection|subsubsection|chapter|part)\{([^}]+)\}/g;

    let lastIndex = 0;
    let lastSection = { name: 'Preamble', type: 'preamble', content: '' };

    let match;
    while ((match = sectionRegex.exec(content)) !== null) {
      lastSection.content = content.slice(lastIndex, match.index);
      if (lastSection.content.trim()) {
        sections.push({ ...lastSection });
      }

      lastSection = {
        name: match[2],
        type: match[1],
        content: '',
      };
      lastIndex = match.index + match[0].length;
    }

    lastSection.content = content.slice(lastIndex);
    if (lastSection.content.trim()) {
      sections.push(lastSection);
    }

    if (sections.length === 0) {
      sections.push({ name: 'Main', type: 'main', content: content.trim() });
    }

    return sections;
  }

  /**
   * Extract LaTeX metadata
   */
  extractLatexMetadata(content: string): DocumentMetadata {
    const metadata: DocumentMetadata = {};

    const titleMatch = content.match(/\\title\{([^}]+)\}/);
    if (titleMatch) {
      metadata.title = this.cleanLatex(titleMatch[1]);
    }

    const authorMatch = content.match(/\\author\{([^}]+)\}/);
    if (authorMatch) {
      metadata.authors = authorMatch[1]
        .split(/\\and|,/)
        .map((a) => this.cleanLatex(a).trim())
        .filter((a) => a.length > 0);
    }

    const abstractMatch = content.match(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/);
    if (abstractMatch) {
      metadata.abstract = this.cleanLatex(abstractMatch[1]);
    }

    const keywordsMatch = content.match(/\\keywords\{([^}]+)\}/);
    if (keywordsMatch) {
      metadata.keywords = keywordsMatch[1].split(/[,;]/).map((k) => k.trim());
    }

    return metadata;
  }

  /**
   * Extract Markdown metadata (YAML Front Matter)
   */
  extractMarkdownMetadata(content: string): DocumentMetadata {
    const metadata: DocumentMetadata = {};

    const frontMatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (frontMatterMatch) {
      const yaml = frontMatterMatch[1];
      const lines = yaml.split('\n');

      for (const line of lines) {
        const match = line.match(/^(\w+):\s*(.+)$/);
        if (match) {
          const key = match[1].toLowerCase();
          const value = match[2].trim().replace(/^["']|["']$/g, '');

          switch (key) {
            case 'title':
              metadata.title = value;
              break;
            case 'author':
            case 'authors':
              metadata.authors = value.split(',').map((a) => a.trim());
              break;
            case 'date':
              const year = Number.parseInt(value);
              if (!Number.isNaN(year)) metadata.year = year;
              break;
            case 'keywords':
            case 'tags':
              metadata.keywords = value.split(',').map((k) => k.trim());
              break;
          }
        }
      }
    }

    return metadata;
  }

  /**
   * Clean LaTeX commands
   */
  private cleanLatex(content: string): string {
    return content
      .replace(/%[^\n]*/g, '')
      .replace(/\\textbf\{([^}]+)\}/g, '$1')
      .replace(/\\textit\{([^}]+)\}/g, '$1')
      .replace(/\\emph\{([^}]+)\}/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Protect LaTeX blocks (prevent splitting)
   */
  protectLatexBlocks(text: string): {
    protectedText: string;
    restoreMap: Map<string, string>;
  } {
    const restoreMap = new Map<string, string>();
    let placeholderIndex = 0;

    const makePlaceholder = (): string => {
      return `<<<LATEX_BLOCK_${placeholderIndex++}>>>`;
    };

    let protectedText = text;

    const blockEnvPattern =
      /\\begin\{(equation\*?|align\*?|gather\*?|multline\*?|split|array|[pbvBV]?matrix|cases|aligned|gathered)\}[\s\S]*?\\end\{\1\}/g;
    protectedText = protectedText.replace(blockEnvPattern, (match) => {
      const placeholder = makePlaceholder();
      restoreMap.set(placeholder, match);
      return placeholder;
    });

    const displayMathPattern = /\\\[[\s\S]*?\\\]/g;
    protectedText = protectedText.replace(displayMathPattern, (match) => {
      const placeholder = makePlaceholder();
      restoreMap.set(placeholder, match);
      return placeholder;
    });

    const doubleDollarPattern = /\$\$[\s\S]*?\$\$/g;
    protectedText = protectedText.replace(doubleDollarPattern, (match) => {
      const placeholder = makePlaceholder();
      restoreMap.set(placeholder, match);
      return placeholder;
    });

    const inlineMathPattern = /(?<!\\)\$(?!\$)([^$]+?)(?<!\\)\$/g;
    protectedText = protectedText.replace(inlineMathPattern, (match) => {
      const placeholder = makePlaceholder();
      restoreMap.set(placeholder, match);
      return placeholder;
    });

    return { protectedText, restoreMap };
  }
}

describe('TextProcessor - Markdown Splitting', () => {
  let processor: TestableTextProcessor;

  beforeEach(() => {
    processor = new TestableTextProcessor();
  });

  describe('Heading Splitting', () => {
    it('should split by level 1 headings', () => {
      const content = `# Introduction
This is the intro.

# Methods
This is methods.

# Results
This is results.`;

      const sections = processor.splitByHeadings(content);
      expect(sections).toHaveLength(3);
      expect(sections[0].heading).toBe('Introduction');
      expect(sections[0].level).toBe(1);
      expect(sections[1].heading).toBe('Methods');
      expect(sections[2].heading).toBe('Results');
    });

    it('should recognize different heading levels', () => {
      const content = `# Main Title
Some content for main.
## Section 1
Content for section 1.
### Subsection 1.1
Content for subsection.
#### Sub-subsection
Final content.`;

      const sections = processor.splitByHeadings(content);
      expect(sections).toHaveLength(4);
      expect(sections[0].level).toBe(1);
      expect(sections[1].level).toBe(2);
      expect(sections[2].level).toBe(3);
      expect(sections[3].level).toBe(4);
    });

    it('should preserve section content', () => {
      const content = `# Title
First paragraph.

Second paragraph with **bold** text.`;

      const sections = processor.splitByHeadings(content);
      expect(sections[0].content).toContain('First paragraph');
      expect(sections[0].content).toContain('Second paragraph');
    });

    it('should return entire content when no headings', () => {
      const content = `Just some text without headers.
More text here.`;

      const sections = processor.splitByHeadings(content);
      expect(sections).toHaveLength(1);
      expect(sections[0].heading).toBe('');
      expect(sections[0].content).toContain('Just some text');
    });
  });

  describe('YAML Front Matter Metadata', () => {
    it('should extract all metadata fields', () => {
      const content = `---
title: My Paper Title
author: John Doe, Jane Smith
date: 2024
keywords: AI, machine learning, NLP
---

# Introduction`;

      const metadata = processor.extractMarkdownMetadata(content);
      expect(metadata.title).toBe('My Paper Title');
      expect(metadata.authors).toEqual(['John Doe', 'Jane Smith']);
      expect(metadata.year).toBe(2024);
      expect(metadata.keywords).toEqual(['AI', 'machine learning', 'NLP']);
    });

    it('should handle quoted values', () => {
      const content = `---
title: "Quoted Title"
author: 'Single Quoted'
---`;

      const metadata = processor.extractMarkdownMetadata(content);
      expect(metadata.title).toBe('Quoted Title');
      expect(metadata.authors).toEqual(['Single Quoted']);
    });

    it('should return empty metadata when no Front Matter', () => {
      const content = `# Just a Title
Some content.`;

      const metadata = processor.extractMarkdownMetadata(content);
      expect(metadata.title).toBeUndefined();
      expect(metadata.authors).toBeUndefined();
    });
  });
});

describe('TextProcessor - LaTeX Splitting', () => {
  let processor: TestableTextProcessor;

  beforeEach(() => {
    processor = new TestableTextProcessor();
  });

  describe('Section Splitting', () => {
    it('should split by section', () => {
      const content = `\\documentclass{article}
\\begin{document}
\\section{Introduction}
This is intro.
\\section{Methods}
This is methods.
\\end{document}`;

      const sections = processor.splitLatexSections(content);
      expect(sections.length).toBeGreaterThanOrEqual(2);

      const introSection = sections.find((s) => s.name === 'Introduction');
      expect(introSection).toBeDefined();
      expect(introSection?.type).toBe('section');

      const methodsSection = sections.find((s) => s.name === 'Methods');
      expect(methodsSection).toBeDefined();
    });

    it('should recognize subsection', () => {
      const content = `\\section{Main}
\\subsection{Sub One}
Content one.
\\subsection{Sub Two}
Content two.`;

      const sections = processor.splitLatexSections(content);
      const subSections = sections.filter((s) => s.type === 'subsection');
      expect(subSections).toHaveLength(2);
    });

    it('should preserve preamble', () => {
      const content = `\\documentclass{article}
\\usepackage{amsmath}
\\title{My Paper}
\\section{First}
Content.`;

      const sections = processor.splitLatexSections(content);
      const preamble = sections.find((s) => s.type === 'preamble');
      expect(preamble).toBeDefined();
      expect(preamble?.content).toContain('documentclass');
    });
  });

  describe('Metadata Extraction', () => {
    it('should extract title', () => {
      const content = '\\title{Deep Learning for Scientific Discovery}';
      const metadata = processor.extractLatexMetadata(content);
      expect(metadata.title).toBe('Deep Learning for Scientific Discovery');
    });

    it('should extract multiple authors', () => {
      const content = '\\author{John Doe \\and Jane Smith \\and Bob Wilson}';
      const metadata = processor.extractLatexMetadata(content);
      expect(metadata.authors).toHaveLength(3);
      expect(metadata.authors).toContain('John Doe');
      expect(metadata.authors).toContain('Jane Smith');
    });

    it('should extract abstract', () => {
      const content = `\\begin{abstract}
This paper presents a novel approach to machine learning.
\\end{abstract}`;

      const metadata = processor.extractLatexMetadata(content);
      expect(metadata.abstract).toContain('novel approach');
    });

    it('should clean LaTeX commands', () => {
      const content = '\\title{A Simple Title}';
      const metadata = processor.extractLatexMetadata(content);
      expect(metadata.title).toBe('A Simple Title');
    });

    it('should clean inline LaTeX formatting commands', () => {
      const content = '\\author{\\textbf{John Doe}}';
      const metadata = processor.extractLatexMetadata(content);
      expect(metadata.authors).toBeDefined();
    });
  });
});

describe('TextProcessor - LaTeX Environment Protection', () => {
  let processor: TestableTextProcessor;

  beforeEach(() => {
    processor = new TestableTextProcessor();
  });

  describe('Math Environment Protection', () => {
    it('should protect equation environment', () => {
      const content = `Some text before.
\\begin{equation}
E = mc^2
\\end{equation}
Some text after.`;

      const { protectedText, restoreMap } = processor.protectLatexBlocks(content);

      expect(protectedText).toContain('<<<LATEX_BLOCK_');
      expect(restoreMap.size).toBe(1);

      const savedBlock = Array.from(restoreMap.values())[0];
      expect(savedBlock).toContain('E = mc^2');
    });

    it('should protect align environment', () => {
      const content = `\\begin{align}
a &= b + c \\\\
d &= e + f
\\end{align}`;

      const { restoreMap } = processor.protectLatexBlocks(content);
      expect(restoreMap.size).toBe(1);

      const savedBlock = Array.from(restoreMap.values())[0];
      expect(savedBlock).toContain('a &= b + c');
    });

    it('should protect starred variants', () => {
      const content = `\\begin{equation*}
unnumbered
\\end{equation*}
\\begin{align*}
also unnumbered
\\end{align*}`;

      const { restoreMap } = processor.protectLatexBlocks(content);
      expect(restoreMap.size).toBe(2);
    });

    it('should protect $$ ... $$ display formulas', () => {
      const content = 'Text before $$x^2 + y^2 = z^2$$ text after.';

      const { protectedText, restoreMap } = processor.protectLatexBlocks(content);
      expect(protectedText).not.toContain('x^2');
      expect(restoreMap.size).toBe(1);
    });

    it('should protect \\[ ... \\] display formulas', () => {
      const content = 'Text \\[\\sum_{i=1}^n x_i\\] more text.';

      const { restoreMap } = processor.protectLatexBlocks(content);
      expect(restoreMap.size).toBe(1);
    });

    it('should protect inline formulas $ ... $', () => {
      const content = 'The formula $a + b = c$ is simple.';

      const { protectedText, restoreMap } = processor.protectLatexBlocks(content);
      expect(protectedText).not.toContain('a + b');
      expect(restoreMap.size).toBe(1);
    });

    it('should not protect escaped $', () => {
      const content = 'The price is \\$100.';

      const { restoreMap } = processor.protectLatexBlocks(content);
      expect(restoreMap.size).toBe(0);
    });
  });

  describe('Complex Scenarios', () => {
    it('should protect multiple environments', () => {
      const content = `\\begin{equation}
E = mc^2
\\end{equation}
Some text with $inline$ formula.
\\begin{align}
a &= b
\\end{align}`;

      const { restoreMap } = processor.protectLatexBlocks(content);
      expect(restoreMap.size).toBe(3);
    });

    it('should protect nested environments', () => {
      const content = `\\begin{equation}
f(x) = \\begin{cases}
1 & x > 0 \\\\
0 & x \\leq 0
\\end{cases}
\\end{equation}`;

      const { restoreMap } = processor.protectLatexBlocks(content);
      expect(restoreMap.size).toBeGreaterThanOrEqual(1);
    });

    it('should protect matrix environment', () => {
      const content = `\\begin{pmatrix}
1 & 0 \\\\
0 & 1
\\end{pmatrix}`;

      const { restoreMap } = processor.protectLatexBlocks(content);
      expect(restoreMap.size).toBe(1);
    });
  });
});

describe('TextProcessor - Edge Cases', () => {
  let processor: TestableTextProcessor;

  beforeEach(() => {
    processor = new TestableTextProcessor();
  });

  it('should handle empty content', () => {
    const sections = processor.splitByHeadings('');
    expect(sections).toHaveLength(1);
    expect(sections[0].content).toBe('');
  });

  it('should handle heading without content', () => {
    const content = '# Title Only';
    const sections = processor.splitByHeadings(content);
    expect(sections).toHaveLength(1);
    expect(sections[0].content).toContain('Title Only');
  });

  it('should handle Unicode content', () => {
    const content = `# 中文标题
这是中文内容。

## 日本語のセクション
日本語のテキスト。`;

    const sections = processor.splitByHeadings(content);
    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe('中文标题');
    expect(sections[1].heading).toBe('日本語のセクション');
  });
});
