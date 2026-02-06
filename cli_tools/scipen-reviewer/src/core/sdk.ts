/**
 * @file sdk.ts - Claude Agent SDK configuration and wrapper
 * @description Provides unified SDK interface and type definitions
 * @depends @anthropic-ai/claude-agent-sdk
 */

import { query, type AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

// Re-export SDK types for convenience
export { query, type AgentDefinition };

/**
 * SciPen system prompt
 */
export const SCIPEN_SYSTEM_PROMPT = `## Project Overview

This repository contains a scientific paper review system called SciPen. The system uses multiple specialized AI agents to evaluate academic papers and generate comprehensive review reports.

## How the System Works

The SciPen system works by:

1. Taking a LaTeX or Markdown paper file as input
2. Running multiple specialized AI agents in parallel to evaluate different aspects of the paper:
   - Paper structure and content analysis
   - Literature review evaluation
   - Experimental design assessment
   - Technical soundness evaluation
   - English writing quality assessment
3. Synthesizing all evaluations into a comprehensive final review report

## Architecture

The system follows a modular agent-based architecture where each agent specializes in a specific aspect of paper evaluation. The main script orchestrates these agents and combines their outputs into a final comprehensive review.
`;

/**
 * SDK message types
 * Reference: https://docs.anthropic.com/en/agent-sdk/typescript
 */
export interface SDKMessage {
  type: 'system' | 'assistant' | 'user' | 'result' | 'stream_event';
  uuid?: string;
  session_id?: string;
  message?: {
    content: Array<{
      type: 'text' | 'tool_use' | 'tool_result';
      text?: string;
      [key: string]: unknown;
    }>;
  };
  subtype?:
    | 'init'
    | 'success'
    | 'error_during_execution'
    | 'error_max_turns'
    | 'error_max_budget_usd'
    | 'error_max_structured_output_retries'
    | 'compact_boundary';
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  is_error?: boolean;
  num_turns?: number;
  structured_output?: unknown;
  errors?: string[];
  [key: string]: unknown;
}

/**
 * Structured output format configuration
 */
export interface OutputFormat {
  type: 'json_schema';
  schema: Record<string, unknown>;
}

/**
 * SDK query options
 */
export interface SDKQueryOptions {
  agents?: Record<string, AgentDefinition>;
  mcpServers?: Record<string, McpServerConfig>;
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  allowDangerouslySkipPermissions?: boolean;
  model?: string;
  maxTurns?: number;
  cwd?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  outputFormat?: OutputFormat;
}

/**
 * MCP Server configuration
 * Reference: https://docs.anthropic.com/en/agent-sdk/typescript#mcpserverconfig
 */
export type McpServerConfig =
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHttpServerConfig
  | McpSdkServerConfig;

export interface McpStdioServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpSSEServerConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
}

export interface McpHttpServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

export interface McpSdkServerConfig {
  type: 'sdk';
  name: string;
  instance: unknown; // McpServer from @modelcontextprotocol/sdk
}

/**
 * Query result type
 */
export interface QueryResult {
  messages: SDKMessage[];
  result: string;
  structuredOutput?: Record<string, unknown>;
}

/**
 * SDK query error
 */
export class SDKQueryError extends Error {
  constructor(
    message: string,
    public readonly subtype: string,
    public readonly errors?: string[]
  ) {
    super(message);
    this.name = 'SDKQueryError';
  }
}

/**
 * Execute agent query
 */
export async function executeQuery(
  prompt: string,
  options: SDKQueryOptions = {}
): Promise<QueryResult> {
  const messages: SDKMessage[] = [];
  let resultText = '';
  let structuredOutput: Record<string, unknown> | undefined;

  for await (const message of query({
    prompt,
    options: {
      agents: options.agents,
      mcpServers: options.mcpServers,
      systemPrompt: options.systemPrompt || SCIPEN_SYSTEM_PROMPT,
      permissionMode: options.permissionMode || 'bypassPermissions',
      allowDangerouslySkipPermissions: options.allowDangerouslySkipPermissions ?? true,
      model: options.model,
      maxTurns: options.maxTurns,
      cwd: options.cwd,
      allowedTools: options.allowedTools,
      disallowedTools: options.disallowedTools,
      outputFormat: options.outputFormat,
    },
  })) {
    messages.push(message as SDKMessage);

    // Extract result text
    if (message.type === 'assistant' && message.message?.content) {
      for (const block of message.message.content) {
        if (block.type === 'text' && block.text) {
          resultText += block.text;
        }
      }
    }

    // Handle result message
    if (message.type === 'result') {
      const msg = message as SDKMessage;

      // Success case
      if (msg.subtype === 'success') {
        if (msg.result) {
          resultText = msg.result;
        }
        // Extract structured output
        if (msg.structured_output) {
          structuredOutput = msg.structured_output as Record<string, unknown>;
        }
      }
      // Error cases
      else if (msg.subtype === 'error_max_structured_output_retries') {
        throw new SDKQueryError(
          'Failed to produce valid structured output after maximum retries',
          msg.subtype,
          msg.errors
        );
      }
      else if (msg.subtype === 'error_max_turns') {
        throw new SDKQueryError(
          'Maximum conversation turns exceeded',
          msg.subtype,
          msg.errors
        );
      }
      else if (msg.subtype === 'error_during_execution') {
        throw new SDKQueryError(
          'Error during query execution',
          msg.subtype,
          msg.errors
        );
      }
      else if (msg.subtype === 'error_max_budget_usd') {
        throw new SDKQueryError(
          'Maximum budget exceeded',
          msg.subtype,
          msg.errors
        );
      }
    }
  }

  return { messages, result: resultText, structuredOutput };
}

/**
 * Create agent execution context
 */
export function createAgentContext(
  agents: Record<string, AgentDefinition>,
  mcpServers?: Record<string, McpServerConfig>
): SDKQueryOptions {
  return {
    agents,
    mcpServers: mcpServers || {},
    systemPrompt: SCIPEN_SYSTEM_PROMPT,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
  };
}

/**
 * Attempt to extract JSON from text
 */
export function extractJsonFromText(text: string): Record<string, unknown> | null {
  // 1. Direct parsing
  try {
    return JSON.parse(text.trim());
  } catch {
    // continue to next method
  }

  // 2. Extract from markdown code block
  const markdownMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (markdownMatch) {
    try {
      return JSON.parse(markdownMatch[1].trim());
    } catch {
      // continue to next method
    }
  }

  // 3. Find JSON object boundaries
  const startIdx = text.indexOf('{');
  const endIdx = text.lastIndexOf('}');
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    try {
      return JSON.parse(text.substring(startIdx, endIdx + 1));
    } catch {
      // failed
    }
  }

  return null;
}

/**
 * Extract structured output from SDK query result
 * Unified handling of structuredOutput and text parsing logic
 *
 * @param structuredOutput Structured output returned by SDK
 * @param resultText Text result returned by agent
 * @param errorContext Error context description (for error messages)
 * @returns Extracted structured data
 * @throws Error if valid JSON cannot be extracted
 */
export function extractStructuredOutput<T>(
  structuredOutput: unknown,
  resultText: string,
  errorContext: string
): T {
  // Prefer SDK-returned structured output
  if (structuredOutput) {
    return structuredOutput as T;
  }

  // Fallback to text parsing
  const extracted = extractJsonFromText(resultText);
  if (extracted) {
    return extracted as T;
  }

  // Cannot extract JSON, throw detailed error
  const preview = resultText.substring(0, 500);
  throw new Error(
    `Failed to extract JSON from ${errorContext}. ` +
    `Agent returned descriptive text instead of JSON. ` +
    `Output preview: "${preview}..."`
  );
}

/**
 * Sanitize sensitive information (API tokens, keys, etc.)
 * Keep first 4 and last 4 characters, replace middle with asterisks
 *
 * @param value String to sanitize
 * @returns Sanitized string
 */
export function sanitizeSensitiveValue(value: string | undefined): string {
  if (!value || value.length <= 8) {
    return '***';
  }

  const prefixLength = 4;
  const suffixLength = 4;
  const prefix = value.substring(0, prefixLength);
  const suffix = value.substring(value.length - suffixLength);
  const maskedLength = value.length - prefixLength - suffixLength;
  const masked = '*'.repeat(Math.min(maskedLength, 8));

  return `${prefix}${masked}${suffix}`;
}

/**
 * Sanitize sensitive information in MCP Server configuration
 * For log recording
 */
export function sanitizeMcpServerConfig(config: McpServerConfig): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...config };

  if ('env' in config && config.env) {
    const sanitizedEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.env)) {
      // Sanitize environment variables containing keywords like TOKEN, KEY, SECRET, PASSWORD
      if (/token|key|secret|password|credential/i.test(key)) {
        sanitizedEnv[key] = sanitizeSensitiveValue(value);
      } else {
        sanitizedEnv[key] = value;
      }
    }
    sanitized.env = sanitizedEnv;
  }

  if ('headers' in config && config.headers) {
    const sanitizedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.headers)) {
      // Sanitize sensitive headers like Authorization
      if (/authorization|token|key|secret/i.test(key)) {
        sanitizedHeaders[key] = sanitizeSensitiveValue(value);
      } else {
        sanitizedHeaders[key] = value;
      }
    }
    sanitized.headers = sanitizedHeaders;
  }

  return sanitized;
}

/**
 * Retry configuration
 */
export interface RetryOptions {
  maxRetries?: number;        // Maximum retry count, default 2
  retryDelayMs?: number;      // Retry delay (milliseconds), default 1000
  onRetry?: (attempt: number, error: Error) => void;  // Retry callback
}

/**
 * Query execution with retry mechanism
 * Automatically retries when JSON parsing fails
 */
export async function executeQueryWithRetry(
  prompt: string,
  options: SDKQueryOptions = {},
  retryOptions: RetryOptions = {}
): Promise<QueryResult> {
  const { maxRetries = 2, retryDelayMs = 1000, onRetry } = retryOptions;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await executeQuery(prompt, options);

      // If outputFormat exists, verify if structured output was successfully obtained
      if (options.outputFormat) {
        if (result.structuredOutput) {
          // SDK returned structured output, success
          return result;
        }

        // SDK did not return structured output, try to extract from text
        const extracted = extractJsonFromText(result.result);
        if (extracted) {
          return {
            ...result,
            structuredOutput: extracted
          };
        }

        // Cannot extract JSON, throw error to trigger retry
        throw new Error(
          `Failed to extract JSON from agent output. ` +
          `Output preview: "${result.result.substring(0, 200)}..."`
        );
      }

      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // If SDK structured output retry error, do not retry
      if (error instanceof SDKQueryError &&
          error.subtype === 'error_max_structured_output_retries') {
        throw error;
      }

      // If retry opportunities remain
      if (attempt < maxRetries) {
        if (onRetry) {
          onRetry(attempt + 1, lastError);
        }
        console.warn(`⚠ Query failed, retrying attempt ${attempt + 2} after ${retryDelayMs}ms...`);
        console.warn(`  Error: ${lastError.message}`);

        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  // All retries failed
  throw lastError || new Error('Query failed after all retries');
}
