/**
 * @file LatexIndexer.ts - LaTeX Indexer
 * @description Parses and indexes labels, citations and file path references in LaTeX documents
 */

export interface LabelInfo {
  name: string;
  type: 'figure' | 'table' | 'equation' | 'section' | 'other';
  file: string;
  line: number;
  context: string; // Context (e.g., figure/table caption)
}

export interface CitationInfo {
  key: string;
  type: string; // article, book, inproceedings, etc.
  author?: string;
  title?: string;
  year?: string;
  journal?: string;
  file: string;
  citedCount: number; // Number of times cited
}

export interface FileInfo {
  path: string;
  type: 'tex' | 'bib' | 'image' | 'other';
  relativePath: string;
}

function parseBibTeX(content: string, filePath: string): CitationInfo[] {
  const entries: CitationInfo[] = [];

  // Match @type{key, ... }
  const entryRegex = /@(\w+)\s*\{\s*([^,\s]+)\s*,([^@]*?)(?=\n\s*@|\n*$)/gs;

  let match;
  while ((match = entryRegex.exec(content)) !== null) {
    const type = match[1].toLowerCase();
    const key = match[2].trim();
    const body = match[3];

    // Parse fields
    const fields: Record<string, string> = {};
    const fieldRegex = /(\w+)\s*=\s*[{"]([^}"]*)[}"]/g;
    let fieldMatch;
    while ((fieldMatch = fieldRegex.exec(body)) !== null) {
      fields[fieldMatch[1].toLowerCase()] = fieldMatch[2].trim();
    }

    entries.push({
      key,
      type,
      author: fields.author,
      title: fields.title,
      year: fields.year,
      journal: fields.journal || fields.booktitle,
      file: filePath,
      citedCount: 0,
    });
  }

  return entries;
}

function parseLabels(content: string, filePath: string): LabelInfo[] {
  const labels: LabelInfo[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const labelMatch = line.match(/\\label\{([^}]+)\}/g);

    if (labelMatch) {
      for (const match of labelMatch) {
        const name = match.match(/\\label\{([^}]+)\}/)?.[1];
        if (!name) continue;

        // Determine type
        let type: LabelInfo['type'] = 'other';
        if (name.startsWith('fig:')) type = 'figure';
        else if (name.startsWith('tab:')) type = 'table';
        else if (name.startsWith('eq:')) type = 'equation';
        else if (name.startsWith('sec:')) type = 'section';

        // Get context (surrounding lines)
        const contextStart = Math.max(0, i - 2);
        const contextEnd = Math.min(lines.length, i + 3);
        const context = lines.slice(contextStart, contextEnd).join('\n');

        // Try to extract more meaningful context (e.g., caption)
        let meaningfulContext = context;
        const captionMatch = context.match(/\\caption\{([^}]+)\}/);
        if (captionMatch) {
          meaningfulContext = captionMatch[1];
        }

        labels.push({
          name,
          type,
          file: filePath,
          line: i + 1,
          context: meaningfulContext,
        });
      }
    }
  }

  return labels;
}

function scanCiteUsage(content: string): Map<string, number> {
  const usage = new Map<string, number>();
  const citeRegex = /\\cite[p]?\{([^}]+)\}/g;

  let match;
  while ((match = citeRegex.exec(content)) !== null) {
    const keys = match[1].split(',').map((k) => k.trim());
    for (const key of keys) {
      usage.set(key, (usage.get(key) || 0) + 1);
    }
  }

  return usage;
}

export class LatexIndexer {
  private labels: LabelInfo[] = [];
  private citations: CitationInfo[] = [];
  private files: FileInfo[] = [];
  private indexedFiles: Set<string> = new Set();
  private citeUsage: Map<string, number> = new Map();

  /**
   * Index entire project
   */
  async indexProject(projectPath: string): Promise<void> {
    this.labels = [];
    this.citations = [];
    this.files = [];
    this.indexedFiles.clear();
    this.citeUsage.clear();

    try {
      await this.scanDirectory(projectPath, '');
    } catch (error) {
      console.error('索引项目失败:', error);
    }
  }

  /**
   * Recursively scan directory
   */
  private async scanDirectory(_basePath: string, _relativePath: string): Promise<void> {
    // TODO: List directory contents via Electron API
    // Currently implemented via file tree
  }

  /**
   * Index a single file
   */
  async indexFile(filePath: string, content: string): Promise<void> {
    const ext = filePath.split('.').pop()?.toLowerCase();

    if (ext === 'bib') {
      await this.indexBibFile(filePath, content);
    } else if (ext === 'tex') {
      await this.indexTexFile(filePath, content);
    }

    this.indexedFiles.add(filePath);
  }

  /**
   * Index BibTeX file
   */
  private async indexBibFile(filePath: string, content: string): Promise<void> {
    // Remove old entries
    this.citations = this.citations.filter((c) => c.file !== filePath);

    // Parse new entries
    const entries = parseBibTeX(content, filePath);

    // Update citation counts
    for (const entry of entries) {
      entry.citedCount = this.citeUsage.get(entry.key) || 0;
    }

    this.citations.push(...entries);
  }

  /**
   * Index TeX file
   */
  private async indexTexFile(filePath: string, content: string): Promise<void> {
    // Remove old labels
    this.labels = this.labels.filter((l) => l.file !== filePath);

    // Parse new labels
    const labels = parseLabels(content, filePath);
    this.labels.push(...labels);

    // Scan citation usage
    const usage = scanCiteUsage(content);
    for (const [key, count] of usage) {
      this.citeUsage.set(key, (this.citeUsage.get(key) || 0) + count);
    }

    // Update citation counts
    for (const cite of this.citations) {
      cite.citedCount = this.citeUsage.get(cite.key) || 0;
    }
  }

  /**
   * Incremental update (called on file save)
   */
  async updateFile(filePath: string, content: string): Promise<void> {
    await this.indexFile(filePath, content);
  }

  getLabels(): LabelInfo[] {
    return this.labels;
  }

  getLabelsByType(type: LabelInfo['type']): LabelInfo[] {
    return this.labels.filter((l) => l.type === type);
  }

  getCitations(): CitationInfo[] {
    return this.citations;
  }

  searchCitations(query: string): CitationInfo[] {
    const q = query.toLowerCase();
    return this.citations
      .filter((c) => {
        return (
          c.key.toLowerCase().includes(q) ||
          c.author?.toLowerCase().includes(q) ||
          c.title?.toLowerCase().includes(q) ||
          c.year?.includes(q)
        );
      })
      .sort((a, b) => b.citedCount - a.citedCount);
  }

  getFiles(extensions?: string[]): string[] {
    if (!extensions) {
      return this.files.map((f) => f.relativePath);
    }
    return this.files
      .filter((f) => extensions.some((ext) => f.path.endsWith(`.${ext}`)))
      .map((f) => f.relativePath);
  }

  addFile(absolutePath: string, relativePath: string): void {
    const ext = absolutePath.split('.').pop()?.toLowerCase();
    let type: FileInfo['type'] = 'other';

    if (ext === 'tex') type = 'tex';
    else if (ext === 'bib') type = 'bib';
    else if (['png', 'jpg', 'jpeg', 'pdf', 'eps', 'svg'].includes(ext || '')) type = 'image';

    this.files.push({
      path: absolutePath,
      type,
      relativePath,
    });
  }

  clear(): void {
    this.labels = [];
    this.citations = [];
    this.files = [];
    this.indexedFiles.clear();
    this.citeUsage.clear();
  }

  getStats(): { labels: number; citations: number; files: number } {
    return {
      labels: this.labels.length,
      citations: this.citations.length,
      files: this.files.length,
    };
  }
}
