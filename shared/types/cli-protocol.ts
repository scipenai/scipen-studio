/**
 * @file CLI Protocol Types
 * @description Communication protocol between sidecar CLI tools and main process
 * @depends None (pure type definitions)
 */

// ====== Tool Names ======

export type CliToolName = 'pdf2latex' | 'reviewer' | 'paper2beamer';

// ====== Configuration Types ======

export interface VlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AnthropicConfig {
  apiKey: string;
  baseUrl?: string;
}

export interface CliSharedConfig {
  vlm?: VlmConfig;
  anthropic?: AnthropicConfig;
  workingDirectory?: string;
  jsonOutput?: boolean;
}

// ====== PDF2LaTeX Types ======

export interface Pdf2LatexParams {
  inputPath: string;
  outputPath?: string;
  dpi?: number;
  concurrent?: number;
}

export interface Pdf2LatexOutputData {
  outputPath: string;
  pageCount: number;
}

// ====== Reviewer Types ======

export interface ReviewerParams {
  inputPath: string;
  outputDir?: string;
}

export interface ReviewerOutputData {
  reportPath: string;
}

// ====== Paper2Beamer Types ======

export interface Paper2BeamerParams {
  inputPath: string;
  outputPath?: string;
  duration?: number;
  template?: string;
}

export interface Paper2BeamerOutputData {
  outputPath: string;
  templates?: string[];
}

// ====== Generic I/O Types ======

export interface CliInput<TParams = unknown> {
  tool: CliToolName;
  version: '1.0';
  params: TParams;
  config: CliSharedConfig;
}

export interface CliProgressEvent {
  current: number;
  total: number;
  message: string;
}

export interface CliOutput<TData = unknown> {
  success: boolean;
  message: string;
  data?: TData;
  progress?: CliProgressEvent;
  error?: {
    code: string;
    details?: string;
  };
  version?: string;
}

// ====== Type Mappings ======

export interface CliParamsMap {
  pdf2latex: Pdf2LatexParams;
  reviewer: ReviewerParams;
  paper2beamer: Paper2BeamerParams;
}

export interface CliOutputDataMap {
  pdf2latex: Pdf2LatexOutputData;
  reviewer: ReviewerOutputData;
  paper2beamer: Paper2BeamerOutputData;
}

// ====== Helper Types ======

export type TypedCliInput<T extends CliToolName> = CliInput<CliParamsMap[T]>;
export type TypedCliOutput<T extends CliToolName> = CliOutput<CliOutputDataMap[T]>;
