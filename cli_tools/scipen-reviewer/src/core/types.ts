/**
 * @file types.ts - SciPen type definitions
 * @description Unified type exports
 * @depends sdk
 */

// Re-export types from SDK module
export type {
  McpServerConfig,
  McpStdioServerConfig,
  McpSSEServerConfig,
  McpHttpServerConfig,
  SDKMessage,
  SDKQueryOptions,
  AgentDefinition,
} from './sdk.js';

/**
 * Review configuration
 */
export interface ReviewConfig {
  paperFile: string;
  outputDir?: string;
  aminerApiKey?: string;
  mineruApiToken?: string;
  skipPreprocessing?: boolean;
}

/**
 * Review result
 */
export interface ReviewResult {
  success: boolean;
  outputDir?: string;
  reportPath?: string;
  errors?: string[];
  taskResults?: Array<{
    name: string;
    success: boolean;
    error?: string;
    duration?: number;
  }>;
  preprocessInfo?: {
    originalFile: string;
    processedFile: string;
    isConverted: boolean;
  };
}

/**
 * Mineru API configuration
 */
export interface MineruApiConfig {
  apiToken: string;
  modelVersion?: 'pipeline' | 'vlm';
  enableFormula?: boolean;
  enableTable?: boolean;
  language?: string;
}
