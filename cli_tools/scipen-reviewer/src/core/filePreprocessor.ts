/**
 * @file filePreprocessor.ts - File preprocessor
 * @description Supports conversion of PDF, DOC, DOCX, PPT, PPTX, images and other formats to Markdown
 * Also supports Markdown and LaTeX as native input formats
 * Uses Mineru API for document parsing
 * @depends fs, path, statusDisplay
 */

import * as fs from 'fs';
import * as path from 'path';
import { StatusDisplay } from '../utils/statusDisplay.js';

// Supported file extensions
const SUPPORTED_EXTENSIONS = ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.png', '.jpg', '.jpeg'];
const LATEX_EXTENSIONS = ['.tex', '.latex'];
const MARKDOWN_EXTENSIONS = ['.md', '.markdown'];

// Mineru API configuration
const MINERU_API_BASE = 'https://mineru.net/api/v4';

export interface MineruConfig {
  apiToken: string;
  modelVersion?: 'pipeline' | 'vlm';
  enableFormula?: boolean;
  enableTable?: boolean;
  language?: string;
}

export interface PreprocessResult {
  originalFile: string;
  processedFile: string;
  isConverted: boolean;
  format: 'latex' | 'markdown' | 'original';
}

// Mineru API response types
interface MineruApiResponse {
  code: number;
  msg?: string;
  data: {
    batch_id: string;
    file_urls: string[];
  };
}

interface MineruExtractResponse {
  code: number;
  msg?: string;
  data: {
    extract_result: Array<{
      state: string;
      full_zip_url?: string;
      err_msg?: string;
      extract_progress?: {
        extracted_pages: number;
        total_pages: number;
      };
    }>;
  };
}

/**
 * Check if file needs preprocessing
 */
export function needsPreprocessing(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS.includes(ext);
}

/**
 * Check if file is a LaTeX file
 */
export function isLatexFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return LATEX_EXTENSIONS.includes(ext);
}

/**
 * Check if file is a Markdown file
 */
export function isMarkdownFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return MARKDOWN_EXTENSIONS.includes(ext);
}

/**
 * Get list of supported file formats
 */
export function getSupportedFormats(): string[] {
  return [...LATEX_EXTENSIONS, ...MARKDOWN_EXTENSIONS, ...SUPPORTED_EXTENSIONS];
}

/**
 * Create Mineru API parsing task (local file upload method)
 */
async function createUploadTask(
  filePath: string,
  config: MineruConfig
): Promise<{ batchId: string; uploadUrl: string }> {
  const fileName = path.basename(filePath);

  const response = await fetch(`${MINERU_API_BASE}/file-urls/batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiToken}`,
    },
    body: JSON.stringify({
      files: [{ name: fileName }],
      model_version: config.modelVersion || 'vlm',
      enable_formula: config.enableFormula ?? true,
      enable_table: config.enableTable ?? true,
      language: config.language || 'en',
      // markdown and json are default export formats, no need to set extra_formats
      // extra_formats only supports docx, html, latex
    }),
  });

  if (!response.ok) {
    throw new Error(`Mineru API request failed: ${response.status} ${response.statusText}`);
  }

  const result = await response.json() as MineruApiResponse;

  if (result.code !== 0) {
    throw new Error(`Mineru API error: ${result.msg} (code: ${result.code})`);
  }

  return {
    batchId: result.data.batch_id,
    uploadUrl: result.data.file_urls[0],
  };
}

/**
 * Upload file to Mineru
 */
async function uploadFile(filePath: string, uploadUrl: string): Promise<void> {
  const fileBuffer = fs.readFileSync(filePath);

  const response = await fetch(uploadUrl, {
    method: 'PUT',
    body: fileBuffer,
  });

  if (!response.ok) {
    throw new Error(`File upload failed: ${response.status} ${response.statusText}`);
  }
}

/**
 * Poll for batch task results
 */
async function pollBatchResult(
  batchId: string,
  config: MineruConfig,
  maxAttempts: number = 120,
  intervalMs: number = 5000
): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetch(`${MINERU_API_BASE}/extract-results/batch/${batchId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get task result: ${response.status}`);
    }

    const result = await response.json() as MineruExtractResponse;

    if (result.code !== 0) {
      throw new Error(`Mineru API error: ${result.msg}`);
    }

    const extractResult = result.data.extract_result[0];
    const state = extractResult.state;

    if (state === 'done') {
      return extractResult.full_zip_url!;
    } else if (state === 'failed') {
      throw new Error(`Document parsing failed: ${extractResult.err_msg}`);
    }

    // Display progress
    if (state === 'running' && extractResult.extract_progress) {
      const progress = extractResult.extract_progress;
      StatusDisplay.printProgress(
        `Parsing: ${progress.extracted_pages}/${progress.total_pages} pages`
      );
    } else {
      StatusDisplay.printProgress(`Status: ${state}`);
    }

    // Wait before retry
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  throw new Error('Document parsing timeout');
}

/**
 * Download and extract results, extract Markdown file
 */
async function downloadAndExtractMarkdown(
  zipUrl: string,
  outputDir: string,
  originalFileName: string
): Promise<string> {
  // Download ZIP file
  const response = await fetch(zipUrl);
  if (!response.ok) {
    throw new Error(`Failed to download results: ${response.status}`);
  }

  const zipBuffer = Buffer.from(await response.arrayBuffer());
  const zipPath = path.join(outputDir, 'mineru_result.zip');
  fs.writeFileSync(zipPath, zipBuffer);

  // Extract ZIP file
  const extractDir = path.join(outputDir, 'mineru_extracted');
  if (!fs.existsSync(extractDir)) {
    fs.mkdirSync(extractDir, { recursive: true });
  }

  // Use Node.js built-in or system commands to extract
  const { execSync } = await import('child_process');

  try {
    // Try unzip (Linux/Mac) or tar (if zip is supported)
    execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: 'pipe' });
  } catch {
    try {
      // Windows: use PowerShell
      execSync(
        `powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`,
        { stdio: 'pipe' }
      );
    } catch (e) {
      throw new Error('Unable to extract file, ensure system supports unzip or PowerShell');
    }
  }

  const outputMdPath = path.join(
    outputDir,
    `${path.basename(originalFileName, path.extname(originalFileName))}.md`
  );

  // Prioritize finding Markdown file
  const mdFile = findMarkdownFile(extractDir);
  if (mdFile) {
    fs.copyFileSync(mdFile, outputMdPath);
    fs.unlinkSync(zipPath);
    return outputMdPath;
  }

  // If no Markdown, try to find LaTeX and convert
  const latexFile = findLatexFile(extractDir);
  if (latexFile) {
    const latexContent = fs.readFileSync(latexFile, 'utf8');
    const mdContent = convertLatexToMarkdown(latexContent);
    fs.writeFileSync(outputMdPath, mdContent, 'utf8');
    fs.unlinkSync(zipPath);
    return outputMdPath;
  }

  throw new Error('No Markdown or LaTeX file found in parsing results');
}

/**
 * Recursively find LaTeX file
 */
function findLatexFile(dir: string): string | null {
  const files = fs.readdirSync(dir);

  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      const found = findLatexFile(fullPath);
      if (found) return found;
    } else if (file.endsWith('.tex')) {
      return fullPath;
    }
  }

  return null;
}

/**
 * Recursively find Markdown file
 */
function findMarkdownFile(dir: string): string | null {
  const files = fs.readdirSync(dir);

  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      const found = findMarkdownFile(fullPath);
      if (found) return found;
    } else if (file.endsWith('.md')) {
      return fullPath;
    }
  }

  return null;
}

/**
 * Convert LaTeX to basic Markdown format
 * Used for preprocessing LaTeX files before AI analysis
 */
function convertLatexToMarkdown(latex: string): string {
  let md = latex;

  // Remove document class and preamble (not needed for markdown conversion)
  md = md.replace(/\\documentclass.*?\n/g, '');
  md = md.replace(/\\usepackage.*?\n/g, '');
  md = md.replace(/\\begin\{document\}/g, '');
  md = md.replace(/\\end\{document\}/g, '');
  md = md.replace(/\\maketitle/g, '');
  md = md.replace(/\\title\{([^}]*)\}/g, '# $1\n');
  md = md.replace(/\\author\{([^}]*)\}/g, '*Author: $1*\n');
  md = md.replace(/\\date\{([^}]*)\}/g, '*Date: $1*\n');

  // Convert section headings to markdown headers
  md = md.replace(/\\section\*?\{([^}]*)\}/g, '# $1');
  md = md.replace(/\\subsection\*?\{([^}]*)\}/g, '## $1');
  md = md.replace(/\\subsubsection\*?\{([^}]*)\}/g, '### $1');

  // Convert text formatting commands
  md = md.replace(/\\textbf\{([^}]*)\}/g, '**$1**');
  md = md.replace(/\\textit\{([^}]*)\}/g, '*$1*');
  md = md.replace(/\\texttt\{([^}]*)\}/g, '`$1`');

  // Convert LaTeX environments to markdown equivalents
  md = md.replace(/\\begin\{verbatim\}([\s\S]*?)\\end\{verbatim\}/g, '```\n$1```');
  md = md.replace(/\\begin\{itemize\}([\s\S]*?)\\end\{itemize\}/g, '$1');
  md = md.replace(/\\begin\{enumerate\}([\s\S]*?)\\end\{enumerate\}/g, '$1');
  md = md.replace(/\\item\s*/g, '- ');

  // Clean up excessive whitespace
  md = md.replace(/\n{3,}/g, '\n\n');

  return md.trim();
}

/**
 * File preprocessor class
 */
export class FilePreprocessor {
  private config: MineruConfig;
  private outputDir: string;

  constructor(mineruApiToken?: string, outputDir?: string) {
    const token = mineruApiToken || process.env.MINERU_API_TOKEN;

    if (!token) {
      throw new Error('Mineru API Token not provided, please set MINERU_API_TOKEN environment variable');
    }

    this.config = {
      apiToken: token,
      modelVersion: 'vlm',
      enableFormula: true,
      enableTable: true,
      language: 'en',
    };

    this.outputDir = outputDir || path.join('.scipen', 'converted');
  }

  /**
   * Preprocess file
   * If LaTeX or Markdown file, return directly
   * If other supported formats, convert to Markdown
   */
  async preprocess(filePath: string): Promise<PreprocessResult> {
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const absolutePath = path.resolve(filePath);

    // If already LaTeX file, return directly
    if (isLatexFile(filePath)) {
      StatusDisplay.printSuccess(`File is already LaTeX format: ${filePath}`);
      return {
        originalFile: absolutePath,
        processedFile: absolutePath,
        isConverted: false,
        format: 'latex',
      };
    }

    // If already Markdown file, return directly
    if (isMarkdownFile(filePath)) {
      StatusDisplay.printSuccess(`File is already Markdown format: ${filePath}`);
      return {
        originalFile: absolutePath,
        processedFile: absolutePath,
        isConverted: false,
        format: 'markdown',
      };
    }

    // Check if format is supported
    if (!needsPreprocessing(filePath)) {
      const ext = path.extname(filePath);
      throw new Error(
        `Unsupported file format: ${ext}\nSupported formats: ${getSupportedFormats().join(', ')}`
      );
    }

    // Ensure output directory exists
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }

    StatusDisplay.printStart(`Converting file: ${path.basename(filePath)}`);
    StatusDisplay.printProgress('Uploading file to Mineru...');

    try {
      // 1. Create upload task
      const { batchId, uploadUrl } = await createUploadTask(absolutePath, this.config);

      // 2. Upload file
      await uploadFile(absolutePath, uploadUrl);
      StatusDisplay.printProgress('File upload completed, waiting for parsing...');

      // 3. Poll for results
      const zipUrl = await pollBatchResult(batchId, this.config);

      // 4. Download and extract Markdown
      StatusDisplay.printProgress('Downloading parsing results...');
      const mdPath = await downloadAndExtractMarkdown(
        zipUrl,
        this.outputDir,
        path.basename(filePath)
      );

      StatusDisplay.printSuccess(`File conversion completed: ${mdPath}`);

      return {
        originalFile: absolutePath,
        processedFile: mdPath,
        isConverted: true,
        format: 'markdown',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      StatusDisplay.printError(`File conversion failed: ${message}`);
      throw error;
    }
  }
}

/**
 * Convenience function: preprocess file
 */
export async function preprocessFile(
  filePath: string,
  mineruApiToken?: string
): Promise<PreprocessResult> {
  const preprocessor = new FilePreprocessor(mineruApiToken);
  return preprocessor.preprocess(filePath);
}
