/**
 * @file BaseProcessor - Document Processor Base Class
 * @description Defines common interface and chunking utilities for all processors (PDF/text/image/audio)
 * @depends ChunkingConfig, ProcessorResult
 */

import {
  type ChunkData,
  type ChunkMetadata,
  type ChunkType,
  type ChunkingConfig,
  DEFAULT_CHUNKING_CONFIG,
  type ProcessorResult,
} from '../types';

/** Processor options */
export interface ProcessorOptions {
  chunkingConfig?: ChunkingConfig;
  enableEmbedding?: boolean;
  [key: string]: unknown;
}

/** Processor context */
export interface ProcessorContext {
  documentId: string;
  libraryId: string;
  filePath: string;
  filename: string;
  options: ProcessorOptions;
}

export abstract class BaseProcessor {
  protected config: ChunkingConfig;

  constructor(config?: Partial<ChunkingConfig>) {
    this.config = { ...DEFAULT_CHUNKING_CONFIG, ...config };
  }

  /**
   * Process document (implemented by subclasses)
   */
  abstract process(context: ProcessorContext): Promise<ProcessorResult>;

  /**
   * Get supported file types
   */
  abstract getSupportedExtensions(): string[];

  /**
   * Get effective chunking configuration
   *
   * Priority: options.chunkingConfig > this.config > DEFAULT_CHUNKING_CONFIG
   *
   * @param options - Processor options, may contain library-level chunking config
   * @returns Merged effective configuration
   */
  protected getEffectiveConfig(options?: ProcessorOptions): ChunkingConfig {
    if (options?.chunkingConfig) {
      return { ...this.config, ...options.chunkingConfig };
    }
    return this.config;
  }

  /**
   * Text chunking
   *
   * Improvements:
   * 1. Protect LaTeX math environments (equation, align, gather, etc.) from being split
   * 2. Protect inline formulas $...$ and $$...$$ from being split
   * 3. Support Chinese punctuation as separators
   *
   * @param text - Text to chunk
   * @param chunkType - Chunk type
   * @param baseMetadata - Base metadata
   * @param configOverride - Optional config override for library-level configuration
   */
  protected chunkText(
    text: string,
    chunkType: ChunkType = 'text',
    baseMetadata: Partial<ChunkMetadata> = {},
    configOverride?: ChunkingConfig
  ): ChunkData[] {
    const chunks: ChunkData[] = [];
    const effectiveConfig = configOverride || this.config;
    const { chunkSize, chunkOverlap, separators } = effectiveConfig;

    // Preprocessing: protect LaTeX block environments and formulas using placeholder replacement
    const { protectedText, restoreMap } = this.protectLatexBlocks(text);

    // Recursive chunking algorithm
    const splitText = (text: string, separatorIndex = 0): string[] => {
      if (text.length <= chunkSize) {
        return [text];
      }

      if (separatorIndex >= separators.length) {
        // No more separators, split by character
        return this.splitByCharacter(text, chunkSize, chunkOverlap);
      }

      const separator = separators[separatorIndex];
      const parts = text.split(separator);

      if (parts.length === 1) {
        // Current separator invalid, try next
        return splitText(text, separatorIndex + 1);
      }

      // Merge parts that are too small
      const mergedParts = this.mergeSmallerParts(parts, chunkSize, separator);

      // Recursively process parts that are still too large
      const result: string[] = [];
      for (const part of mergedParts) {
        if (part.length > chunkSize) {
          result.push(...splitText(part, separatorIndex + 1));
        } else {
          result.push(part);
        }
      }

      return result;
    };

    const textChunks = splitText(protectedText.trim());
    let currentOffset = 0;

    for (let i = 0; i < textChunks.length; i++) {
      // Restore LaTeX placeholders to original content
      const content = this.restoreLatexBlocks(textChunks[i], restoreMap).trim();
      if (content.length === 0) continue;

      // Find offset in original text
      const startOffset = text.indexOf(content, currentOffset);
      const endOffset =
        startOffset >= 0 ? startOffset + content.length : currentOffset + content.length;

      chunks.push({
        content,
        chunkType,
        metadata: {
          ...baseMetadata,
          startOffset: startOffset >= 0 ? startOffset : undefined,
          endOffset: startOffset >= 0 ? endOffset : undefined,
          chunkLength: content.length,
        },
      });

      currentOffset = startOffset >= 0 ? endOffset : currentOffset + content.length;
    }

    return chunks;
  }

  /**
   * Protect LaTeX block environments and formulas from being split by chunking algorithm
   *
   * Why protection is needed:
   * - Truncated LaTeX environments (e.g., only \begin{} without \end{}) cause syntax errors
   * - Incomplete formulas cannot be correctly understood by embedding models, degrading retrieval quality
   * - Users will see incomplete, uncompilable code snippets in retrieval results
   *
   * Protected content:
   * - Math environments: equation, align, gather, multline, array, matrix, etc.
   * - Semantic environments: theorem, lemma, proof, definition, proposition, corollary, remark
   * - Document environments: figure, table, tabular, itemize, enumerate, description
   * - Code environments: lstlisting, verbatim, minted
   * - Inline formulas: $...$, $$...$$, \[...\], \(...\)
   */
  private protectLatexBlocks(text: string): {
    protectedText: string;
    restoreMap: Map<string, string>;
  } {
    const restoreMap = new Map<string, string>();
    let placeholderIndex = 0;

    // Generate unique placeholder
    const makePlaceholder = (): string => {
      return `<<<LATEX_BLOCK_${placeholderIndex++}>>>`;
    };

    let protectedText = text;

    // 1. Protect math environments
    // equation, align, gather, multline, split, array, matrix series, cases, subequations
    const mathEnvPattern =
      /\\begin\{(equation\*?|align\*?|gather\*?|multline\*?|split\*?|eqnarray\*?|subequations|array|[pbvBV]?matrix|cases|aligned|gathered)\}[\s\S]*?\\end\{\1\}/g;
    protectedText = protectedText.replace(mathEnvPattern, (match) => {
      const placeholder = makePlaceholder();
      restoreMap.set(placeholder, match);
      return placeholder;
    });

    // 2. Protect semantic environments (theorem, lemma, proof, etc.)
    // These environments typically contain complete mathematical arguments; splitting would break the logical chain
    const semanticEnvPattern =
      /\\begin\{(theorem|lemma|proof|definition|proposition|corollary|remark|example|exercise|conjecture|claim|assumption|notation|observation|question)\}[\s\S]*?\\end\{\1\}/g;
    protectedText = protectedText.replace(semanticEnvPattern, (match) => {
      const placeholder = makePlaceholder();
      restoreMap.set(placeholder, match);
      return placeholder;
    });

    // 3. Protect document structure environments (figure, table, etc.)
    // Figure/table environments contain captions; splitting would lose critical descriptions
    const structEnvPattern =
      /\\begin\{(figure\*?|table\*?|tabular\*?|tabularx|longtable|subfigure|subtable)\}[\s\S]*?\\end\{\1\}/g;
    protectedText = protectedText.replace(structEnvPattern, (match) => {
      const placeholder = makePlaceholder();
      restoreMap.set(placeholder, match);
      return placeholder;
    });

    // 4. Protect list environments
    const listEnvPattern = /\\begin\{(itemize|enumerate|description)\}[\s\S]*?\\end\{\1\}/g;
    protectedText = protectedText.replace(listEnvPattern, (match) => {
      const placeholder = makePlaceholder();
      restoreMap.set(placeholder, match);
      return placeholder;
    });

    // 5. Protect code environments
    const codeEnvPattern =
      /\\begin\{(lstlisting|verbatim|minted|algorithm|algorithmic)\}[\s\S]*?\\end\{\1\}/g;
    protectedText = protectedText.replace(codeEnvPattern, (match) => {
      const placeholder = makePlaceholder();
      restoreMap.set(placeholder, match);
      return placeholder;
    });

    // 6. Protect \[ ... \] display math mode
    const displayMathPattern = /\\\[[\s\S]*?\\\]/g;
    protectedText = protectedText.replace(displayMathPattern, (match) => {
      const placeholder = makePlaceholder();
      restoreMap.set(placeholder, match);
      return placeholder;
    });

    // 7. Protect $$ ... $$ display formulas
    const doubleDollarPattern = /\$\$[\s\S]*?\$\$/g;
    protectedText = protectedText.replace(doubleDollarPattern, (match) => {
      const placeholder = makePlaceholder();
      restoreMap.set(placeholder, match);
      return placeholder;
    });

    // 8. Protect $ ... $ inline formulas (avoid matching escaped \$)
    // Use negative lookbehind to ensure $ is not preceded by a backslash
    const inlineMathPattern = /(?<!\\)\$(?!\$)([^$]+?)(?<!\\)\$/g;
    protectedText = protectedText.replace(inlineMathPattern, (match) => {
      const placeholder = makePlaceholder();
      restoreMap.set(placeholder, match);
      return placeholder;
    });

    // 9. Protect \( ... \) inline math mode
    const inlineParenPattern = /\\\([\s\S]*?\\\)/g;
    protectedText = protectedText.replace(inlineParenPattern, (match) => {
      const placeholder = makePlaceholder();
      restoreMap.set(placeholder, match);
      return placeholder;
    });

    return { protectedText, restoreMap };
  }

  private restoreLatexBlocks(text: string, restoreMap: Map<string, string>): string {
    let restored = text;
    for (const [placeholder, original] of restoreMap) {
      restored = restored.replace(placeholder, original);
    }
    return restored;
  }

  private splitByCharacter(text: string, chunkSize: number, overlap: number): string[] {
    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      const end = Math.min(start + chunkSize, text.length);
      chunks.push(text.slice(start, end));
      start += chunkSize - overlap;
    }

    return chunks;
  }

  private mergeSmallerParts(parts: string[], maxSize: number, separator: string): string[] {
    const merged: string[] = [];
    let current = '';

    for (const part of parts) {
      const testMerge = current ? current + separator + part : part;

      if (testMerge.length <= maxSize) {
        current = testMerge;
      } else {
        if (current) {
          merged.push(current);
        }
        current = part;
      }
    }

    if (current) {
      merged.push(current);
    }

    return merged;
  }

  protected cleanText(text: string): string {
    return text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  protected extractTitle(text: string, maxLength = 100): string {
    const firstLine = text.split('\n')[0].trim();
    if (firstLine.length <= maxLength) {
      return firstLine;
    }
    return `${firstLine.slice(0, maxLength)}...`;
  }

  protected createSummaryChunk(content: string, parentChunks: ChunkData[]): ChunkData {
    return {
      content,
      chunkType: 'summary',
      metadata: {
        isSummary: true,
        sourceChunkCount: parentChunks.length,
      },
    };
  }
}
