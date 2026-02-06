/**
 * @file TextProcessor - Text Processor
 * @description Processes Markdown/plain text/LaTeX, chunks by headings while preserving math environment integrity
 * @depends BaseProcessor, ChunkingConfig
 */

import * as path from 'path';
import type { ChunkData, ChunkingConfig, DocumentMetadata, ProcessorResult } from '../types';
import fs from '../utils/fsCompat';
import { BaseProcessor, type ProcessorContext } from './BaseProcessor';

export class TextProcessor extends BaseProcessor {
  getSupportedExtensions(): string[] {
    return ['.txt', '.md', '.markdown', '.tex', '.latex', '.rst', '.org'];
  }

  async process(context: ProcessorContext): Promise<ProcessorResult> {
    try {
      const { filePath, filename, options } = context;
      const ext = path.extname(filename).toLowerCase();

      // Use library-level config if available, otherwise fall back to default
      const effectiveConfig = this.getEffectiveConfig(options);

      const content = await fs.readFile(filePath, 'utf-8');
      const cleanedContent = this.cleanText(content);

      // Choose processing method based on file extension
      let chunks: ChunkData[];
      let metadata: DocumentMetadata = {};

      switch (ext) {
        case '.md':
        case '.markdown':
          chunks = this.processMarkdown(cleanedContent, effectiveConfig);
          metadata = this.extractMarkdownMetadata(cleanedContent);
          break;
        case '.tex':
        case '.latex':
          chunks = this.processLatex(cleanedContent, effectiveConfig);
          metadata = this.extractLatexMetadata(cleanedContent);
          break;
        default:
          chunks = this.processPlainText(cleanedContent, effectiveConfig);
      }

      metadata.title = metadata.title || this.extractTitle(cleanedContent);

      return {
        success: true,
        chunks,
        metadata,
      };
    } catch (error) {
      return {
        success: false,
        chunks: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private processMarkdown(content: string, config: ChunkingConfig): ChunkData[] {
    const chunks: ChunkData[] = [];

    const sections = this.splitByHeadings(content);

    for (const section of sections) {
      const sectionChunks = this.chunkText(
        section.content,
        'text',
        {
          section: section.heading,
          level: section.level,
        },
        config
      );
      chunks.push(...sectionChunks);
    }

    return chunks;
  }

  private splitByHeadings(
    content: string
  ): Array<{ heading: string; level: number; content: string }> {
    const lines = content.split('\n');
    const sections: Array<{ heading: string; level: number; content: string }> = [];

    let currentSection = { heading: '', level: 0, content: '' };

    for (const line of lines) {
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

      if (headingMatch) {
        // Save current section before starting a new one
        if (currentSection.content.trim()) {
          sections.push({ ...currentSection, content: currentSection.content.trim() });
        }

        // Start new section
        currentSection = {
          heading: headingMatch[2],
          level: headingMatch[1].length,
          content: '',
        };
      } else {
        currentSection.content += `${line}\n`;
      }
    }

    // Save the last section
    if (currentSection.content.trim()) {
      sections.push({ ...currentSection, content: currentSection.content.trim() });
    }

    // If no headings found, treat entire content as a single section
    if (sections.length === 0) {
      sections.push({ heading: '', level: 0, content: content.trim() });
    }

    return sections;
  }

  private extractMarkdownMetadata(content: string): DocumentMetadata {
    const metadata: DocumentMetadata = {};

    const frontMatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (frontMatterMatch) {
      const yaml = frontMatterMatch[1];

      // Simple YAML parsing (key-value pairs only)
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

  private processLatex(content: string, config: ChunkingConfig): ChunkData[] {
    const chunks: ChunkData[] = [];

    const sections = this.splitLatexSections(content);

    for (const section of sections) {
      const cleanedContent = this.cleanLatex(section.content);

      if (cleanedContent.trim()) {
        const sectionChunks = this.chunkText(
          cleanedContent,
          'text',
          {
            section: section.name,
            sectionType: section.type,
          },
          config
        );
        chunks.push(...sectionChunks);
      }
    }

    return chunks;
  }

  private splitLatexSections(
    content: string
  ): Array<{ name: string; type: string; content: string }> {
    const sections: Array<{ name: string; type: string; content: string }> = [];

    // Match LaTeX section commands (\section, \subsection, \chapter, etc.)
    const sectionRegex = /\\(section|subsection|subsubsection|chapter|part)\{([^}]+)\}/g;

    let lastIndex = 0;
    let lastSection = { name: 'Preamble', type: 'preamble', content: '' };

    let match;
    while ((match = sectionRegex.exec(content)) !== null) {
      // Save previous section's content before starting new section
      lastSection.content = content.slice(lastIndex, match.index);
      if (lastSection.content.trim()) {
        sections.push({ ...lastSection });
      }

      // Start new section
      lastSection = {
        name: match[2],
        type: match[1],
        content: '',
      };
      lastIndex = match.index + match[0].length;
    }

    // Save the last section
    lastSection.content = content.slice(lastIndex);
    if (lastSection.content.trim()) {
      sections.push(lastSection);
    }

    // If no sections found, treat entire content as a single section
    if (sections.length === 0) {
      sections.push({ name: 'Main', type: 'main', content: content.trim() });
    }

    return sections;
  }

  private cleanLatex(content: string): string {
    return (
      content
        .replace(/%[^\n]*/g, '')
        // Remove formatting commands but preserve their content
        .replace(/\\textbf\{([^}]+)\}/g, '$1')
        .replace(/\\textit\{([^}]+)\}/g, '$1')
        .replace(/\\emph\{([^}]+)\}/g, '$1')
        .replace(/\\underline\{([^}]+)\}/g, '$1')
        .replace(/\\cite\{[^}]+\}/g, '')
        .replace(/\\ref\{[^}]+\}/g, '')
        .replace(/\\label\{[^}]+\}/g, '')
        .replace(/\\begin\{[^}]+\}/g, '')
        .replace(/\\end\{[^}]+\}/g, '')
        .replace(/\\[a-zA-Z]+(\[[^\]]*\])?\{[^}]*\}/g, '')
        .replace(/\\[a-zA-Z]+/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    );
  }

  /**
   * Extract LaTeX metadata
   */
  private extractLatexMetadata(content: string): DocumentMetadata {
    const metadata: DocumentMetadata = {};

    // Extract title
    const titleMatch = content.match(/\\title\{([^}]+)\}/);
    if (titleMatch) {
      metadata.title = this.cleanLatex(titleMatch[1]);
    }

    // Extract authors
    const authorMatch = content.match(/\\author\{([^}]+)\}/);
    if (authorMatch) {
      metadata.authors = authorMatch[1]
        .split(/\\and|,/)
        .map((a) => this.cleanLatex(a).trim())
        .filter((a) => a.length > 0);
    }

    // Extract abstract
    const abstractMatch = content.match(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/);
    if (abstractMatch) {
      metadata.abstract = this.cleanLatex(abstractMatch[1]);
    }

    // Extract keywords
    const keywordsMatch = content.match(/\\keywords\{([^}]+)\}/);
    if (keywordsMatch) {
      metadata.keywords = keywordsMatch[1].split(/[,;]/).map((k) => k.trim());
    }

    return metadata;
  }

  private processPlainText(content: string, config: ChunkingConfig): ChunkData[] {
    return this.chunkText(content, 'text', {}, config);
  }
}
