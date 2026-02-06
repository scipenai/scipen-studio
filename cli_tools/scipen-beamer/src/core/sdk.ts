/**
 * @file sdk.ts - Claude Agent SDK wrapper
 * @description Provides unified SDK interface, type definitions, and LaTeX compilation utilities
 * @depends @anthropic-ai/claude-agent-sdk
 */

import { query, type AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

export { query, type AgentDefinition };

/** System prompt */
export const SCIPEN_BEAMER_SYSTEM_PROMPT = `## Project Overview

This is SciPen Beamer, a tool for converting academic papers to Beamer presentations.
The system uses specialized AI agents to analyze papers and generate presentation slides.

## How the System Works

The SciPen Beamer system works by:

1. Taking a LaTeX paper file as input
2. Running specialized AI agents in sequence:
   - Paper Analysis Agent: Extracts metadata, structure, and key contributions
   - Presentation Planner Agent: Creates slide-by-slide plan with timing
   - Beamer Generator Agent: Generates compilable LaTeX/Beamer code
   - Compilation Fixer Agent: Automatically fixes LaTeX compilation errors
3. Optionally compiling the generated LaTeX to PDF

## Architecture

The system follows a sequential pipeline architecture where each agent builds
upon the output of the previous agent. All agents output structured JSON data
that is processed by the controller.

## Important Constraints

- If diagrams are needed, use TikZ or describe the content in text/bullet points.
- For tables and data, present them directly in LaTeX tabular format.
`;

/** SDK message types */
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
  systemPrompt?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  allowDangerouslySkipPermissions?: boolean;
  model?: string;
  maxTurns?: number;
  cwd?: string;
  /** Additional accessible directories - for allowing Agent to access paper file directory */
  additionalDirectories?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  outputFormat?: OutputFormat;
  /** Real-time message callback */
  onMessage?: (message: SDKMessage) => void;
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

/** Execute Agent query */
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
      systemPrompt: options.systemPrompt || SCIPEN_BEAMER_SYSTEM_PROMPT,
      permissionMode: options.permissionMode || 'bypassPermissions',
      allowDangerouslySkipPermissions: options.allowDangerouslySkipPermissions ?? true,
      model: options.model,
      maxTurns: options.maxTurns,
      cwd: options.cwd,
      additionalDirectories: options.additionalDirectories,
      allowedTools: options.allowedTools,
      disallowedTools: options.disallowedTools,
      outputFormat: options.outputFormat,
    },
  })) {
    const sdkMessage = message as SDKMessage;
    messages.push(sdkMessage);

    if (options.onMessage) {
      try {
        options.onMessage(sdkMessage);
      } catch {
        // ignore callback errors
      }
    }

    if (sdkMessage.type === 'assistant' && sdkMessage.message?.content) {
      for (const block of sdkMessage.message.content) {
        if (block.type === 'text' && block.text) {
          resultText += block.text;
        }
      }
    }

    if (sdkMessage.type === 'result') {
      const msg = sdkMessage;

      if (msg.subtype === 'success') {
        if (msg.result) {
          resultText = msg.result;
        }
        if (msg.structured_output) {
          structuredOutput = msg.structured_output as Record<string, unknown>;
        }
      } else if (msg.subtype === 'error_max_structured_output_retries') {
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

/** Create Agent execution context */
export function createAgentContext(
  agents: Record<string, AgentDefinition>,
  additionalDirectories?: string[]
): SDKQueryOptions {
  return {
    agents,
    systemPrompt: SCIPEN_BEAMER_SYSTEM_PROMPT,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    additionalDirectories,
  };
}

/**
 * Attempt to extract JSON from text
 */
export function extractJsonFromText(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text.trim());
  } catch { /* continue */ }

  const markdownMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (markdownMatch) {
    try {
      return JSON.parse(markdownMatch[1].trim());
    } catch { /* continue */ }
  }

  const startIdx = text.indexOf('{');
  const endIdx = text.lastIndexOf('}');
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    try {
      return JSON.parse(text.substring(startIdx, endIdx + 1));
    } catch { /* failed */ }
  }

  return null;
}

/** Extract structured output from SDK query result */
export function extractStructuredOutput<T>(
  structuredOutput: unknown,
  resultText: string,
  errorContext: string
): T {
  if (structuredOutput) {
    return structuredOutput as T;
  }

  const extracted = extractJsonFromText(resultText);
  if (extracted) {
    return extracted as T;
  }

  const preview = resultText.substring(0, 500);
  throw new Error(
    `Failed to extract JSON from ${errorContext}. ` +
    `Agent returned descriptive text instead of JSON. ` +
    `Output preview: "${preview}..."`
  );
}

/**
 * Retry configuration
 */
export interface RetryOptions {
  maxRetries?: number;
  retryDelayMs?: number;
  onRetry?: (attempt: number, error: Error) => void;
}

/**
 * Query execution with retry mechanism
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

      if (options.outputFormat) {
        if (result.structuredOutput) {
          return result;
        }

        const extracted = extractJsonFromText(result.result);
        if (extracted) {
          return {
            ...result,
            structuredOutput: extracted
          };
        }

        throw new Error(
          `Failed to extract JSON from agent output. ` +
          `Output preview: "${result.result.substring(0, 200)}..."`
        );
      }

      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (error instanceof SDKQueryError &&
          error.subtype === 'error_max_structured_output_retries') {
        throw error;
      }

      if (attempt < maxRetries) {
        if (onRetry) {
          onRetry(attempt + 1, lastError);
        }
        console.warn(`⚠ Query failed, retrying attempt ${attempt + 2} after ${retryDelayMs}ms...`);
        console.warn(`  Error: ${lastError.message}`);

        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  throw lastError || new Error('Query failed after all retries');
}

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export function hasLatexCompiler(): boolean {
  try {
    execSync('xelatex --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export interface CompileResult {
  success: boolean;
  pdfPath?: string;
  logContent?: string;
  errorSummary?: string;
}

export function compileLatex(texPath: string, outputDir: string): CompileResult {
  const texFileName = path.basename(texPath);
  const pdfFileName = texFileName.replace('.tex', '.pdf');
  const logFileName = texFileName.replace('.tex', '.log');
  const pdfPath = path.join(outputDir, pdfFileName);
  const logPath = path.join(outputDir, logFileName);

  try {
    execSync(
      `xelatex -interaction=nonstopmode -output-directory="${outputDir}" "${texPath}"`,
      { cwd: outputDir, stdio: 'pipe', timeout: 120000 }
    );
    execSync(
      `xelatex -interaction=nonstopmode -output-directory="${outputDir}" "${texPath}"`,
      { cwd: outputDir, stdio: 'pipe', timeout: 120000 }
    );

    if (fs.existsSync(pdfPath)) {
      return { success: true, pdfPath };
    } else {
      const logContent = fs.existsSync(logPath)
        ? fs.readFileSync(logPath, 'utf8')
        : 'No log file found';
      return { success: false, logContent, errorSummary: 'PDF was not generated' };
    }
  } catch (error: unknown) {
    const logContent = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, 'utf8')
      : 'No log file found';
    const errorSummary = extractLatexErrors(logContent);
    return { success: false, logContent, errorSummary };
  }
}

export function extractLatexErrors(logContent: string): string {
  const lines = logContent.split('\n');
  const errors: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('!')) {
      const errorLines = [line];
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        if (lines[j].startsWith('!') || lines[j].startsWith('l.')) {
          errorLines.push(lines[j]);
        }
      }
      errors.push(errorLines.join('\n'));
    }
  }

  if (errors.length === 0) {
    for (const line of lines) {
      if (
        line.includes('Fatal error') ||
        line.includes('Emergency stop') ||
        line.includes('No pages of output')
      ) {
        errors.push(line);
      }
    }
  }

  return errors.length > 0
    ? errors.slice(0, 5).join('\n\n')
    : 'Unknown error - check full log';
}

export function ensureOutputDirs(baseDir: string): {
  outputDir: string;
  logDir: string;
  jsonDir: string;
} {
  const logDir = path.join(baseDir, 'log');
  const jsonDir = path.join(baseDir, 'json');

  for (const dir of [baseDir, logDir, jsonDir]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  return { outputDir: baseDir, logDir, jsonDir };
}
