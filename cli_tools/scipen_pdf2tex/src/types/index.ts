export interface ConversionOptions {
  input: string;
  output: string;
  baseURL?: string;
  apiKey?: string;
  model?: string;
  dpi?: number;
  concurrent?: number;
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
  maxRetries?: number;
}

export interface PDFPageImage {
  pageNumber: number;
  imageBuffer: Buffer;
  width: number;
  height: number;
}

export interface LaTeXContent {
  pageNumber: number;
  content: string;
}

export interface VLMConfig {
  baseURL: string;
  apiKey?: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  defaultDpi?: number;
  defaultConcurrent?: number;
  timeout?: number;
  maxRetries?: number;
  systemPromptOverride?: string;
}

export interface LocalConfig {
  vlm: VLMConfig;
}
