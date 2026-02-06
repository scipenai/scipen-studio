/**
 * @file IAgentService - Agent service contract
 * @description Public interface for agent CLI integrations
 * @depends AgentService
 */

// ====== Type Definitions ======

/**
 * Agent result payload.
 */
export interface AgentResultData {
  outputPath?: string;
  templates?: string[];
  [key: string]: unknown;
}

/**
 * Agent execution result.
 */
export interface AgentResult {
  success: boolean;
  message: string;
  data?: AgentResultData;
  progress?: number;
}

/**
 * Agent execution options.
 */
export interface AgentExecutionOptions {
  onProgress?: (message: string, progress: number) => void;
  workingDirectory?: string;
  timeout?: number;
}

/**
 * PDF-to-LaTeX configuration.
 */
export interface Pdf2LatexConfig {
  outputFile?: string;
  concurrent?: number;
  /** VLM API base URL (optional, falls back to app AI config). */
  baseUrl?: string;
  /** VLM API key (optional, falls back to app AI config). */
  apiKey?: string;
  /** VLM model name (optional, falls back to app AI config). */
  model?: string;
}

/**
 * Paper-to-Beamer configuration.
 */
export interface Paper2BeamerConfig {
  duration?: number;
  template?: string;
  output?: string;
}

// ====== Interface Definition ======

/**
 * Agent service interface.
 */
export interface IAgentService {
  /**
   * Converts a PDF into LaTeX.
   * @param inputFile Input file path
   * @param config Conversion configuration
   * @param options Execution options
   */
  pdf2latex(
    inputFile: string,
    config?: Pdf2LatexConfig,
    options?: AgentExecutionOptions
  ): Promise<AgentResult>;

  /**
   * Runs paper review.
   * @param inputFile Input file path
   * @param options Execution options
   */
  reviewPaper(inputFile: string, options?: AgentExecutionOptions): Promise<AgentResult>;

  /**
   * Converts a paper into Beamer slides.
   * @param inputFile Input file path
   * @param config Conversion configuration
   * @param options Execution options
   */
  paper2beamer(
    inputFile: string,
    config?: Paper2BeamerConfig,
    options?: AgentExecutionOptions
  ): Promise<AgentResult>;

  /**
   * Lists available Beamer templates.
   */
  listBeamerTemplates(): Promise<AgentResult>;

  /**
   * Checks availability of CLI tools.
   */
  checkAvailability(): Promise<{
    pdf2latex: boolean;
    reviewer: boolean;
    paper2beamer: boolean;
  }>;

  /**
   * Terminates the currently running process.
   * @sideeffect Stops active CLI invocation
   */
  killCurrentProcess(): boolean;
}
