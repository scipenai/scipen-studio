/**
 * @file reviewer.ts - Main review controller
 * @description Coordinates the entire paper review process
 * @depends fs, path, os, statusDisplay, parallelExecutor, agents, filePreprocessor, types, sdk
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StatusDisplay } from '../utils/statusDisplay.js';

/** Get SciPen global directory (~/.scipen) */
function getScipenHomeDir(): string {
  return path.join(os.homedir(), '.scipen');
}
import {
  executeParallelTasks,
  executeComprehensiveReview,
  type TaskResult
} from './parallelExecutor.js';
import { comprehensiveReviewConfig } from '../agents/definitions.js';
import {
  FilePreprocessor,
  isLatexFile,
  needsPreprocessing,
  getSupportedFormats,
  type PreprocessResult
} from './filePreprocessor.js';
import type { ReviewConfig, ReviewResult } from './types.js';
import { type McpServerConfig } from './sdk.js';

export interface ReviewerConfig {
  aminerApiKey?: string;
  mineruApiToken?: string;
}

export class Reviewer {
  private outputDir!: string;
  private logDir!: string;
  private reportDir!: string;
  private jsonDir!: string;
  private convertedDir!: string;
  private mcpServers: Record<string, McpServerConfig>;
  private mineruApiToken?: string;

  constructor(config?: ReviewerConfig) {
    // Store Mineru API Token for PDF conversion
    this.mineruApiToken = config?.mineruApiToken || process.env.MINERU_API_TOKEN;

    // Configure MCP Servers for external integrations
    this.mcpServers = {};

    const aminerApiKey = config?.aminerApiKey || process.env.AMINER_API_KEY;
    if (aminerApiKey) {
      this.mcpServers['aminer-mcp-server'] = {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@scipen/aminer-mcp-server'],
        env: {
          AMINER_API_KEY: aminerApiKey,
        },
      };
    }
  }

  /**
   * Initialize output directories based on paper file
   * Output to ~/.scipen/reviewer/<paper-name>/
   */
  private initOutputDirs(paperFile: string): void {
    const reviewerBaseDir = path.join(getScipenHomeDir(), 'reviewer');
    const ext = path.extname(paperFile);
    const rawPaperName = path.basename(paperFile, ext);
    // Clean illegal characters from filename
    const paperName = rawPaperName.replace(/[<>:"|?*]/g, '-');

    this.outputDir = path.join(reviewerBaseDir, paperName);
    this.logDir = path.join(this.outputDir, 'log');
    this.reportDir = path.join(this.outputDir, 'reports');
    this.jsonDir = path.join(this.outputDir, 'json');
    this.convertedDir = path.join(this.outputDir, 'converted');
  }

  /**
   * Ensure output directories exist
   */
  private ensureDirectories(): void {
    const dirs = [this.outputDir, this.logDir, this.reportDir, this.jsonDir, this.convertedDir];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Preprocess file (if needed)
   */
  private async preprocessFile(
    filePath: string,
    skipPreprocessing?: boolean
  ): Promise<PreprocessResult> {
    // If LaTeX file, return directly
    if (isLatexFile(filePath)) {
      return {
        originalFile: path.resolve(filePath),
        processedFile: path.resolve(filePath),
        isConverted: false,
        format: 'original',
      };
    }

    // If preprocessing is needed but user chose to skip
    if (skipPreprocessing) {
      throw new Error(
        `File '${filePath}' is not LaTeX format and requires preprocessing.\n` +
        `Please provide MINERU_API_TOKEN environment variable, or use LaTeX format file.\n` +
        `Supported formats: ${getSupportedFormats().join(', ')}`
      );
    }

    // Check if format is supported
    if (!needsPreprocessing(filePath)) {
      const ext = path.extname(filePath);
      throw new Error(
        `Unsupported file format: ${ext}\n` +
        `Supported formats: ${getSupportedFormats().join(', ')}`
      );
    }

    // Check Mineru API Token
    if (!this.mineruApiToken) {
      throw new Error(
        `File '${filePath}' needs to be converted to LaTeX format.\n` +
        `Please set MINERU_API_TOKEN environment variable to enable file conversion.\n` +
        `Or provide LaTeX format paper file directly.`
      );
    }

    // Execute preprocessing
    StatusDisplay.printPhase('Preprocessing Stage: File Format Conversion');

    const preprocessor = new FilePreprocessor(this.mineruApiToken, this.convertedDir);
    return preprocessor.preprocess(filePath);
  }

  /**
   * Validate input file
   */
  private validateInputFile(paperFile: string): void {
    // Check if file exists
    if (!fs.existsSync(paperFile)) {
      throw new Error(`File '${paperFile}' does not exist`);
    }

    // Check if it's a file (not a directory)
    const stats = fs.statSync(paperFile);
    if (!stats.isFile()) {
      throw new Error(`'${paperFile}' is not a valid file`);
    }

    // Check file size limit (50MB)
    const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
    if (stats.size > MAX_FILE_SIZE) {
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      throw new Error(`File too large: ${sizeMB}MB (maximum supported: 50MB)`);
    }

    // Check file size cannot be empty
    if (stats.size === 0) {
      throw new Error(`File '${paperFile}' is empty`);
    }

    // Check if file is readable
    try {
      fs.accessSync(paperFile, fs.constants.R_OK);
    } catch {
      throw new Error(`File '${paperFile}' cannot be read, please check file permissions`);
    }

    // Validate file extension
    const ext = path.extname(paperFile).toLowerCase();
    const supportedExts = ['.tex', '.latex', '.md', '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.png', '.jpg', '.jpeg'];
    if (!supportedExts.includes(ext)) {
      throw new Error(
        `Unsupported file format: ${ext}\n` +
        `Supported formats: ${getSupportedFormats().join(', ')}`
      );
    }
  }

  /**
   * Execute complete paper review process
   */
  async review(config: ReviewConfig): Promise<ReviewResult> {
    const { paperFile, skipPreprocessing } = config;

    // Validate input file
    try {
      this.validateInputFile(paperFile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        errors: [`Input validation failed: ${message}`],
      };
    }

    // Initialize output directories based on paper name
    this.initOutputDirs(paperFile);

    // Display header
    StatusDisplay.printHeader('Scientific Paper Review System (SciPen)');
    StatusDisplay.printFileInfo('Input File', paperFile);
    StatusDisplay.printFileInfo('Output Directory', this.outputDir);

    // Ensure directories exist
    this.ensureDirectories();

    // Preprocess file (if needed)
    let preprocessResult: PreprocessResult;
    try {
      preprocessResult = await this.preprocessFile(paperFile, skipPreprocessing);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        errors: [`File preprocessing failed: ${message}`],
      };
    }

    // Use processed file path
    const processedFile = preprocessResult.processedFile;

    if (preprocessResult.isConverted) {
      StatusDisplay.printFileInfo('Converted File', processedFile);
    }

    const allResults: TaskResult[] = [];

    // Stage 1: Execute evaluation tasks in parallel
    const parallelResults = await executeParallelTasks({
      paperFile: processedFile,
      reportDir: this.reportDir,
      logDir: this.logDir,
      jsonDir: this.jsonDir,
      mcpServers: this.mcpServers,
    });
    allResults.push(...parallelResults);

    // Stage 2: Generate comprehensive review report
    const comprehensiveResult = await executeComprehensiveReview(
      {
        paperFile: processedFile,
        reportDir: this.reportDir,
        logDir: this.logDir,
        jsonDir: this.jsonDir,
        mcpServers: this.mcpServers,
      },
      comprehensiveReviewConfig
    );
    allResults.push(comprehensiveResult);

    // Display task summary
    StatusDisplay.printTaskSummary(allResults);

    // Display completion information
    StatusDisplay.printHeader('Scientific Paper Review Process Completed!');

    const reportPath = path.join(this.reportDir, comprehensiveReviewConfig.reportFileName);
    const hasErrors = allResults.some(r => !r.success);

    return {
      success: !hasErrors,
      outputDir: this.outputDir,
      reportPath: fs.existsSync(reportPath) ? reportPath : undefined,
      errors: allResults.filter(r => !r.success).map(r => `${r.name}: ${r.error}`),
      taskResults: allResults,
      preprocessInfo: {
        originalFile: preprocessResult.originalFile,
        processedFile: preprocessResult.processedFile,
        isConverted: preprocessResult.isConverted,
      },
    };
  }
}

/**
 * Convenience function: execute paper review
 */
export async function reviewPaper(
  paperFile: string,
  options?: {
    aminerApiKey?: string;
    mineruApiToken?: string;
    skipPreprocessing?: boolean;
  }
): Promise<ReviewResult> {
  const reviewer = new Reviewer({
    aminerApiKey: options?.aminerApiKey,
    mineruApiToken: options?.mineruApiToken,
  });
  return reviewer.review({
    paperFile,
    skipPreprocessing: options?.skipPreprocessing,
  });
}
