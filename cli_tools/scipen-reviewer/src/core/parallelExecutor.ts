/**
 * @file parallelExecutor.ts - Parallel task executor
 * @description Executes multiple agent tasks in parallel using Claude Agent SDK
 * @depends fs, path, statusDisplay, sdk, agents, schemas, templateRenderer
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { StatusDisplay } from '../utils/statusDisplay.js';

// Define __dirname for ES modules (Node.js ESM doesn't provide it by default)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import {
  executeQuery,
  executeQueryWithRetry,
  createAgentContext,
  extractStructuredOutput,
  type McpServerConfig,
  type SDKMessage,
  type OutputFormat,
  type RetryOptions,
} from './sdk.js';
import {
  allAgents,
  agentTaskConfigs,
  type AgentTaskConfig
} from '../agents/definitions.js';
import {
  reviewDataSchema,
  englishQualitySchema,
  paperAnalysisSchema,
  experimentalEvaluationSchema,
  technicalEvaluationSchema,
  literatureReviewSchema,
  type ReviewData,
  type EnglishQualityData,
  type PaperAnalysisData,
  type ExperimentalEvaluationData,
  type TechnicalEvaluationData,
  type LiteratureReviewData
} from './schemas.js';
import {
  renderReviewReport,
  renderEnglishQualityReport,
  renderPaperAnalysisReport,
  renderExperimentalEvaluationReport,
  renderTechnicalEvaluationReport,
  renderLiteratureReviewReport,
  generateReportId,
  type ReviewReportData,
  type EnglishQualityReportData,
  type PaperAnalysisReportData,
  type ExperimentalEvaluationReportData,
  type TechnicalEvaluationReportData,
  type LiteratureReviewReportData
} from './templateRenderer.js';

export interface TaskResult {
  name: string;
  success: boolean;
  error?: string;
  duration?: number;
}

export interface ExecutorOptions {
  paperFile: string;
  reportDir: string;
  logDir: string;
  jsonDir: string;  // JSON data save directory
  mcpServers?: Record<string, McpServerConfig>;
}

/**
 * Generate BibTeX file
 * Convert missing_literature array to complete BibTeX format
 * Includes all information returned by AMiner: title, authors, abstract, DOI, URL, keywords, etc.
 */
function generateBibTeX(
  missingLiterature: Array<{
    title: string;
    authors: Array<{ name: string; org?: string | null }>;
    venue?: string;
    year: number;
    citations?: number;
    abstract?: string;
    doi?: string;
    url?: string;
    keywords?: string[];
    relevance_explanation: string;
  }>
): string {
  if (!missingLiterature || missingLiterature.length === 0) {
    return '% No missing literature identified\n';
  }

  let bibContent = '% ============================================\n';
  bibContent += '% Related Literature discovered by Scipen AI via AMiner\n';
  bibContent += '% Generated automatically during literature review evaluation\n';
  bibContent += '% ============================================\n\n';

  missingLiterature.forEach((paper, index) => {
    // Generate BibTeX key: first author last name + year + index
    const firstAuthor = paper.authors[0]?.name || 'Unknown';
    const lastName = firstAuthor.split(' ').pop() || 'Unknown';
    // Clean special characters from key
    const cleanLastName = lastName.replace(/[^a-zA-Z]/g, '').toLowerCase();
    const bibKey = `${cleanLastName}${paper.year}_${index + 1}`;

    // Format author list to BibTeX format: "LastName, FirstName and LastName, FirstName"
    const authorsFormatted = paper.authors
      .map(a => {
        const parts = a.name.split(' ');
        if (parts.length >= 2) {
          const lastName = parts.pop();
          const firstName = parts.join(' ');
          return `${lastName}, ${firstName}`;
        }
        return a.name;
      })
      .join(' and ');

    bibContent += `@article{${bibKey},\n`;
    bibContent += `  title = {${paper.title}},\n`;
    bibContent += `  author = {${authorsFormatted}},\n`;
    bibContent += `  year = {${paper.year}},\n`;

    // Optional fields
    if (paper.venue) {
      bibContent += `  journal = {${paper.venue}},\n`;
    }
    if (paper.doi) {
      bibContent += `  doi = {${paper.doi}},\n`;
    }
    if (paper.url) {
      bibContent += `  url = {${paper.url}},\n`;
    }
    if (paper.citations !== undefined) {
      bibContent += `  note = {Citations: ${paper.citations}},\n`;
    }
    if (paper.keywords && paper.keywords.length > 0) {
      bibContent += `  keywords = {${paper.keywords.join(', ')}},\n`;
    }
    if (paper.abstract) {
      // Escape BibTeX special characters
      const escapedAbstract = paper.abstract
        .replace(/\\/g, '\\textbackslash{}')
        .replace(/[{}]/g, '\\$&')
        .replace(/%/g, '\\%')
        .replace(/&/g, '\\&')
        .replace(/#/g, '\\#')
        .replace(/_/g, '\\_');
      bibContent += `  abstract = {${escapedAbstract}},\n`;
    }

    // Relevance explanation as comment
    bibContent += `  annote = {Relevance: ${paper.relevance_explanation}}\n`;
    bibContent += `}\n\n`;
  });

  return bibContent;
}

/**
 * Execute single agent task
 */
async function executeAgentTask(
  config: AgentTaskConfig,
  options: ExecutorOptions
): Promise<TaskResult> {
  const startTime = Date.now();
  const { paperFile, reportDir, logDir, mcpServers } = options;

  // Build prompt
  const prompt = config.promptTemplate
    .replace('{paperFile}', paperFile)
    .replace(/{reportDir}/g, reportDir)
    .replace('{reportFileName}', config.reportFileName);

  const logFilePath = path.join(logDir, config.logFileName);
  let logContent = '';

  try {
    logContent += `=== ${config.displayName} started ===\n`;
    logContent += `Time: ${new Date().toISOString()}\n`;
    logContent += `Paper file: ${paperFile}\n`;
    logContent += `Prompt: ${prompt}\n\n`;

    StatusDisplay.printStart(config.displayName);

    // Create agent context and execute query
    const context = createAgentContext(allAgents, mcpServers);
    const { messages, result } = await executeQuery(prompt, context);

    // Log messages to log file
    for (const message of messages) {
      logContent += `[${message.type}] ${JSON.stringify(message, null, 2)}\n`;
    }

    logContent += `\n=== ${config.displayName} completed ===\n`;
    logContent += `Result: ${result.slice(0, 500)}...\n`;
    fs.writeFileSync(logFilePath, logContent, 'utf8');

    // For parallel tasks, agent should have already written report file
    // No need to save result here, as agent will use Write tool

    const duration = Date.now() - startTime;
    StatusDisplay.printSuccess(`${config.displayName} (${(duration / 1000).toFixed(1)}s)`);

    return {
      name: config.displayName,
      success: true,
      duration,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logContent += `\nError: ${errorMessage}\n`;
    fs.writeFileSync(logFilePath, logContent, 'utf8');

    StatusDisplay.printError(config.displayName, errorMessage);

    return {
      name: config.displayName,
      success: false,
      error: errorMessage,
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Execute English quality assessment task (using structured output)
 */
async function executeEnglishQualityTask(
  config: AgentTaskConfig,
  options: ExecutorOptions
): Promise<TaskResult> {
  const startTime = Date.now();
  const { paperFile, reportDir, logDir, jsonDir, mcpServers } = options;

  // Build prompt (does not include Write instruction, as we use structured output)
  const prompt = `Assess English writing quality and academic style compliance of ${paperFile}. Analyze the paper and provide structured JSON output with grammar corrections, sentence improvements, vocabulary enhancements, and style compliance assessment.
Avoid line numbers or positional references. Use Typst math syntax for all formulas.

CRITICAL: You MUST respond with valid JSON only. Do NOT include any explanatory text, markdown formatting, or natural language before or after the JSON. Your entire response must be a single JSON object that matches the required schema.`;

  const logFilePath = path.join(logDir, config.logFileName);
  let logContent = '';

  try {
    logContent += `=== ${config.displayName} started (Structured Output) ===\n`;
    logContent += `Time: ${new Date().toISOString()}\n`;
    logContent += `Paper file: ${paperFile}\n`;
    logContent += `Prompt: ${prompt}\n\n`;

    StatusDisplay.printStart(config.displayName);

    // Create agent context, use structured output
    const context = createAgentContext(allAgents, mcpServers);

    const outputFormat: OutputFormat = {
      type: 'json_schema',
      schema: englishQualitySchema as Record<string, unknown>
    };

    const { messages, result, structuredOutput } = await executeQuery(prompt, {
      ...context,
      outputFormat
    });

    // Log messages to log file
    for (const message of messages) {
      logContent += `[${message.type}] ${JSON.stringify(message, null, 2)}\n`;
    }

    // Get structured output data
    const englishData = extractStructuredOutput<EnglishQualityData>(
      structuredOutput,
      result,
      'English Quality Agent output'
    );

    if (structuredOutput) {
      logContent += `\n=== Structured output received from SDK ===\n`;
    } else {
      logContent += `\n=== WARNING: No structured_output from SDK, extracted from text ===\n`;
    }

    // Save JSON data to json directory
    const jsonPath = path.join(jsonDir, 'english-quality-data.json');
    fs.writeFileSync(jsonPath, JSON.stringify(englishData, null, 2), 'utf8');

    // Render Typst report
    const templatePath = path.join(__dirname, '..', 'templates', 'english-quality.typ');
    const typstPath = path.join(reportDir, config.reportFileName);

    const reportData: EnglishQualityReportData = {
      ...englishData,
      report_id: generateReportId(),
      date: new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      })
    };

    renderEnglishQualityReport(reportData, templatePath, typstPath);

    logContent += `\n=== ${config.displayName} completed ===\n`;
    logContent += `JSON saved to: ${jsonPath}\n`;
    logContent += `Typst rendered to: ${typstPath}\n`;
    fs.writeFileSync(logFilePath, logContent, 'utf8');

    const duration = Date.now() - startTime;
    StatusDisplay.printSuccess(`${config.displayName} (${(duration / 1000).toFixed(1)}s)`);

    return {
      name: config.displayName,
      success: true,
      duration,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logContent += `\nError: ${errorMessage}\n`;
    fs.writeFileSync(logFilePath, logContent, 'utf8');

    StatusDisplay.printError(config.displayName, errorMessage);

    return {
      name: config.displayName,
      success: false,
      error: errorMessage,
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Execute paper analysis task (using structured output)
 */
async function executePaperAnalysisTask(
  config: AgentTaskConfig,
  options: ExecutorOptions
): Promise<TaskResult> {
  const startTime = Date.now();
  const { paperFile, reportDir, logDir, jsonDir, mcpServers } = options;

  const prompt = `Analyze this paper ${paperFile}. Extract key information including title, authors, content summary, research objectives, methodology, key findings, innovation points, structural analysis, and complexity assessment.
Avoid line numbers or positional references. Use Typst math syntax for all formulas.

CRITICAL: You MUST respond with valid JSON only. Do NOT include any explanatory text, markdown formatting, or natural language before or after the JSON. Your entire response must be a single JSON object that matches the required schema.`;

  const logFilePath = path.join(logDir, config.logFileName);
  let logContent = `=== ${config.displayName} started (Structured Output) ===\n`;
  logContent += `Time: ${new Date().toISOString()}\nPaper file: ${paperFile}\n\n`;

  try {
    StatusDisplay.printStart(config.displayName);

    const context = createAgentContext(allAgents, mcpServers);
    const outputFormat: OutputFormat = {
      type: 'json_schema',
      schema: paperAnalysisSchema as Record<string, unknown>
    };

    const { messages, result, structuredOutput } = await executeQuery(prompt, {
      ...context,
      outputFormat
    });

    for (const message of messages) {
      logContent += `[${message.type}] ${JSON.stringify(message, null, 2)}\n`;
    }

    const data = extractStructuredOutput<PaperAnalysisData>(
      structuredOutput,
      result,
      'Paper Analysis Agent output'
    );

    const jsonPath = path.join(jsonDir, 'paper-analysis-data.json');
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8');

    const templatePath = path.join(__dirname, '..', 'templates', 'paper-analysis.typ');
    const typstPath = path.join(reportDir, config.reportFileName);

    const reportData: PaperAnalysisReportData = {
      ...data,
      report_id: generateReportId(),
      date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    };

    renderPaperAnalysisReport(reportData, templatePath, typstPath);

    logContent += `\nJSON saved to: ${jsonPath}\nTypst rendered to: ${typstPath}\n`;
    fs.writeFileSync(logFilePath, logContent, 'utf8');

    const duration = Date.now() - startTime;
    StatusDisplay.printSuccess(`${config.displayName} (${(duration / 1000).toFixed(1)}s)`);

    return { name: config.displayName, success: true, duration };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logContent += `\nError: ${errorMessage}\n`;
    fs.writeFileSync(logFilePath, logContent, 'utf8');
    StatusDisplay.printError(config.displayName, errorMessage);
    return { name: config.displayName, success: false, error: errorMessage, duration: Date.now() - startTime };
  }
}

/**
 * Execute experimental evaluation task (using structured output)
 */
async function executeExperimentalEvaluationTask(
  config: AgentTaskConfig,
  options: ExecutorOptions
): Promise<TaskResult> {
  const startTime = Date.now();
  const { paperFile, reportDir, logDir, jsonDir, mcpServers } = options;

  const prompt = `Evaluate the experimental design and results validity of ${paperFile}. Assess experimental methodology, statistical validity, data presentation quality, and reproducibility. Provide scores and detailed analysis.
Avoid line numbers or positional references. Use Typst math syntax for all formulas.

CRITICAL: You MUST respond with valid JSON only. Do NOT include any explanatory text, markdown formatting, or natural language before or after the JSON. Your entire response must be a single JSON object that matches the required schema.`;

  const logFilePath = path.join(logDir, config.logFileName);
  let logContent = `=== ${config.displayName} started (Structured Output) ===\n`;
  logContent += `Time: ${new Date().toISOString()}\nPaper file: ${paperFile}\n\n`;

  try {
    StatusDisplay.printStart(config.displayName);

    const context = createAgentContext(allAgents, mcpServers);
    const outputFormat: OutputFormat = {
      type: 'json_schema',
      schema: experimentalEvaluationSchema as Record<string, unknown>
    };

    const { messages, result, structuredOutput } = await executeQuery(prompt, {
      ...context,
      outputFormat
    });

    for (const message of messages) {
      logContent += `[${message.type}] ${JSON.stringify(message, null, 2)}\n`;
    }

    const data = extractStructuredOutput<ExperimentalEvaluationData>(
      structuredOutput,
      result,
      'Experimental Evaluation Agent output'
    );

    if (structuredOutput) {
      logContent += `\n=== Structured output received from SDK ===\n`;
    } else {
      logContent += `\n=== WARNING: No structured_output from SDK, extracted from text ===\n`;
    }

    const jsonPath = path.join(jsonDir, 'experimental-evaluation-data.json');
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8');

    const templatePath = path.join(__dirname, '..', 'templates', 'experimental-evaluation.typ');
    const typstPath = path.join(reportDir, config.reportFileName);

    const reportData: ExperimentalEvaluationReportData = {
      ...data,
      report_id: generateReportId(),
      date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    };

    renderExperimentalEvaluationReport(reportData, templatePath, typstPath);

    logContent += `\nJSON saved to: ${jsonPath}\nTypst rendered to: ${typstPath}\n`;
    fs.writeFileSync(logFilePath, logContent, 'utf8');

    const duration = Date.now() - startTime;
    StatusDisplay.printSuccess(`${config.displayName} (${(duration / 1000).toFixed(1)}s)`);

    return { name: config.displayName, success: true, duration };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logContent += `\nError: ${errorMessage}\n`;
    fs.writeFileSync(logFilePath, logContent, 'utf8');
    StatusDisplay.printError(config.displayName, errorMessage);
    return { name: config.displayName, success: false, error: errorMessage, duration: Date.now() - startTime };
  }
}

/**
 * Execute technical evaluation task (using structured output)
 */
async function executeTechnicalEvaluationTask(
  config: AgentTaskConfig,
  options: ExecutorOptions
): Promise<TaskResult> {
  const startTime = Date.now();
  const { paperFile, reportDir, logDir, jsonDir, mcpServers } = options;

  const prompt = `Evaluate the technical soundness and mathematical rigor of ${paperFile}. Verify mathematical correctness, assess methodological innovation, identify technical flaws, and provide constructive recommendations.
Avoid line numbers or positional references. Use Typst math syntax for all formulas.

CRITICAL: You MUST respond with valid JSON only. Do NOT include any explanatory text, markdown formatting, or natural language before or after the JSON. Your entire response must be a single JSON object that matches the required schema.`;

  const logFilePath = path.join(logDir, config.logFileName);
  let logContent = `=== ${config.displayName} started (Structured Output) ===\n`;
  logContent += `Time: ${new Date().toISOString()}\nPaper file: ${paperFile}\n\n`;

  try {
    StatusDisplay.printStart(config.displayName);

    const context = createAgentContext(allAgents, mcpServers);
    const outputFormat: OutputFormat = {
      type: 'json_schema',
      schema: technicalEvaluationSchema as Record<string, unknown>
    };

    // Use query with retry mechanism, technical evaluation is prone to failure so add retries
    const retryOptions: RetryOptions = {
      maxRetries: 2,
      retryDelayMs: 2000,
      onRetry: (attempt, error) => {
        logContent += `\n=== Retry ${attempt}/${2}: ${error.message} ===\n`;
        StatusDisplay.printWarning(`${config.displayName} retrying (${attempt}/2)...`);
      }
    };

    const { messages, result, structuredOutput } = await executeQueryWithRetry(
      prompt,
      { ...context, outputFormat },
      retryOptions
    );

    for (const message of messages) {
      logContent += `[${message.type}] ${JSON.stringify(message, null, 2)}\n`;
    }

    const data = extractStructuredOutput<TechnicalEvaluationData>(
      structuredOutput,
      result,
      'Technical Evaluation Agent output'
    );

    if (structuredOutput) {
      logContent += `\n=== Structured output received from SDK ===\n`;
    } else {
      logContent += `\n=== WARNING: No structured_output from SDK, extracted from text ===\n`;
    }

    const jsonPath = path.join(jsonDir, 'technical-evaluation-data.json');
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8');

    const templatePath = path.join(__dirname, '..', 'templates', 'technical-evaluation.typ');
    const typstPath = path.join(reportDir, config.reportFileName);

    const reportData: TechnicalEvaluationReportData = {
      ...data,
      report_id: generateReportId(),
      date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    };

    renderTechnicalEvaluationReport(reportData, templatePath, typstPath);

    logContent += `\nJSON saved to: ${jsonPath}\nTypst rendered to: ${typstPath}\n`;
    fs.writeFileSync(logFilePath, logContent, 'utf8');

    const duration = Date.now() - startTime;
    StatusDisplay.printSuccess(`${config.displayName} (${(duration / 1000).toFixed(1)}s)`);

    return { name: config.displayName, success: true, duration };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logContent += `\nError: ${errorMessage}\n`;
    fs.writeFileSync(logFilePath, logContent, 'utf8');
    StatusDisplay.printError(config.displayName, errorMessage);
    return { name: config.displayName, success: false, error: errorMessage, duration: Date.now() - startTime };
  }
}

/**
 * Execute literature review evaluation task (using structured output)
 */
async function executeLiteratureReviewTask(
  config: AgentTaskConfig,
  options: ExecutorOptions
): Promise<TaskResult> {
  const startTime = Date.now();
  const { paperFile, reportDir, logDir, jsonDir, mcpServers } = options;

  const prompt = `Evaluate the literature review of ${paperFile}. Use aminer-mcp-server tools to search for relevant literature. Analyze completeness, accuracy, logic, positioning, and timeliness. Identify missing important works and provide improvement recommendations.
Avoid line numbers or positional references. Use Typst math syntax for all formulas.

CRITICAL: You MUST respond with valid JSON only. Do NOT include any explanatory text, markdown formatting, or natural language before or after the JSON. Your entire response must be a single JSON object that matches the required schema.`;

  const logFilePath = path.join(logDir, config.logFileName);
  let logContent = `=== ${config.displayName} started (Structured Output) ===\n`;
  logContent += `Time: ${new Date().toISOString()}\nPaper file: ${paperFile}\n\n`;

  try {
    StatusDisplay.printStart(config.displayName);

    const context = createAgentContext(allAgents, mcpServers);
    const outputFormat: OutputFormat = {
      type: 'json_schema',
      schema: literatureReviewSchema as Record<string, unknown>
    };

    const { messages, result, structuredOutput } = await executeQuery(prompt, {
      ...context,
      outputFormat
    });

    for (const message of messages) {
      logContent += `[${message.type}] ${JSON.stringify(message, null, 2)}\n`;
    }

    const data = extractStructuredOutput<LiteratureReviewData>(
      structuredOutput,
      result,
      'Literature Review Agent output'
    );

    const jsonPath = path.join(jsonDir, 'literature-review-data.json');
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8');

    const templatePath = path.join(__dirname, '..', 'templates', 'literature-review.typ');
    const typstPath = path.join(reportDir, config.reportFileName);

    const reportData: LiteratureReviewReportData = {
      ...data,
      report_id: generateReportId(),
      date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    };

    renderLiteratureReviewReport(reportData, templatePath, typstPath);

    // Generate BibTeX file
    const bibContent = generateBibTeX(data.missing_literature);
    const bibPath = path.join(reportDir, 'related-literature.bib');
    fs.writeFileSync(bibPath, bibContent, 'utf8');

    logContent += `\nJSON saved to: ${jsonPath}\nTypst rendered to: ${typstPath}\nBibTeX saved to: ${bibPath}\n`;
    fs.writeFileSync(logFilePath, logContent, 'utf8');

    const duration = Date.now() - startTime;
    StatusDisplay.printSuccess(`${config.displayName} (${(duration / 1000).toFixed(1)}s)`);

    return { name: config.displayName, success: true, duration };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logContent += `\nError: ${errorMessage}\n`;
    fs.writeFileSync(logFilePath, logContent, 'utf8');
    StatusDisplay.printError(config.displayName, errorMessage);
    return { name: config.displayName, success: false, error: errorMessage, duration: Date.now() - startTime };
  }
}

/**
 * Execute all evaluation agents in parallel
 * All agents use structured output
 */
export async function executeParallelTasks(
  options: ExecutorOptions
): Promise<TaskResult[]> {
  StatusDisplay.printPhase('Stage 1: Execute Paper Analysis Tasks in Parallel');

  // Display all task launches
  for (const config of agentTaskConfigs) {
    StatusDisplay.printLaunch(config.displayName);
  }

  // Execute all tasks in parallel, select corresponding execution function based on agent type
  const taskPromises = agentTaskConfigs.map(config => {
    switch (config.agentName) {
      case 'paper-analysis-agent':
        return executePaperAnalysisTask(config, options);
      case 'experimental-evaluator':
        return executeExperimentalEvaluationTask(config, options);
      case 'technical-paper-evaluator':
        return executeTechnicalEvaluationTask(config, options);
      case 'english-polishing-agent':
        return executeEnglishQualityTask(config, options);
      case 'literature-review-evaluator':
        return executeLiteratureReviewTask(config, options);
      default:
        return executeAgentTask(config, options);
    }
  });

  // Use Promise.allSettled to ensure all tasks complete, even if some fail
  const settledResults = await Promise.allSettled(taskPromises);

  // Convert results, handle failed tasks
  const results = settledResults.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value;
    } else {
      // Task was rejected, create failed TaskResult
      const config = agentTaskConfigs[index];
      const errorMessage = result.reason instanceof Error
        ? result.reason.message
        : String(result.reason);

      StatusDisplay.printError(config.displayName, errorMessage);

      return {
        name: config.displayName,
        success: false,
        error: errorMessage,
        duration: 0
      };
    }
  });

  return results;
}

/**
 * Execute comprehensive review task
 * Use SDK structured output to ensure valid JSON data is returned
 */
export async function executeComprehensiveReview(
  options: ExecutorOptions,
  comprehensiveConfig: AgentTaskConfig
): Promise<TaskResult> {
  StatusDisplay.printPhase('Stage 2: Generate Comprehensive Review Report');

  const startTime = Date.now();
  const { paperFile, reportDir, logDir, jsonDir, mcpServers } = options;

  // Build prompt
  const basePrompt = comprehensiveConfig.promptTemplate
    .replace('{paperFile}', paperFile)
    .replace(/{reportDir}/g, reportDir)
    .replace('{reportFileName}', 'review-data.json');

  const prompt = `${basePrompt}
Avoid line numbers or positional references. Use Typst math syntax for all formulas.

CRITICAL: You MUST respond with valid JSON only. Do NOT include any explanatory text, markdown formatting, or natural language before or after the JSON. Your entire response must be a single JSON object that matches the required schema.`;

  const logFilePath = path.join(logDir, comprehensiveConfig.logFileName);
  let logContent = '';

  try {
    logContent += `=== ${comprehensiveConfig.displayName} started ===\n`;
    logContent += `Time: ${new Date().toISOString()}\n`;
    logContent += `Paper file: ${paperFile}\n`;
    logContent += `Prompt: ${prompt}\n\n`;
    logContent += `Using structured output with JSON Schema\n\n`;

    StatusDisplay.printStart(comprehensiveConfig.displayName);

    // Create agent context, add structured output configuration
    const context = createAgentContext(allAgents, mcpServers);

    // Use SDK structured output functionality
    const outputFormat: OutputFormat = {
      type: 'json_schema',
      schema: reviewDataSchema as Record<string, unknown>
    };

    const { messages, result, structuredOutput } = await executeQuery(prompt, {
      ...context,
      outputFormat
    });

    // Log messages to log file
    for (const message of messages) {
      logContent += `[${message.type}] ${JSON.stringify(message, null, 2)}\n`;
    }

    // Get structured output data
    const reviewData = extractStructuredOutput<ReviewData>(
      structuredOutput,
      result,
      'Comprehensive Review Agent output'
    );

    if (structuredOutput) {
      logContent += `\n=== Structured output received from SDK ===\n`;
    } else {
      logContent += `\n=== WARNING: No structured_output from SDK, extracted from text ===\n`;
    }

    // Save JSON data to json directory
    const jsonPath = path.join(jsonDir, 'review-data.json');
    fs.writeFileSync(jsonPath, JSON.stringify(reviewData, null, 2), 'utf8');

    // Render Typst report
    const templatePath = path.join(__dirname, '..', 'templates', 'review-report.typ');
    const typstPath = path.join(reportDir, comprehensiveConfig.reportFileName);

    // Validate and clean data: remove empty categories
    const cleanedReviewData = {
      ...reviewData,
      strength_categories: reviewData.strength_categories?.filter(
        cat => cat.items && cat.items.length > 0 && cat.items.some(item => item.trim())
      ) || [],
      weakness_categories: reviewData.weakness_categories?.filter(
        cat => cat.items && cat.items.length > 0 && cat.items.some(item => item.trim())
      ) || [],
    };

    // Check for empty categories
    const emptyStrengths = (reviewData.strength_categories?.length || 0) - cleanedReviewData.strength_categories.length;
    const emptyWeaknesses = (reviewData.weakness_categories?.length || 0) - cleanedReviewData.weakness_categories.length;
    
    if (emptyStrengths > 0 || emptyWeaknesses > 0) {
      logContent += `\n⚠ Warning: Removed ${emptyStrengths} empty strength categories and ${emptyWeaknesses} empty weakness categories\n`;
      console.warn(`⚠ Warning: Removed ${emptyStrengths} empty strength categories and ${emptyWeaknesses} empty weakness categories`);
    }

    // Build complete report data (add report_id and date)
    const reportData: ReviewReportData = {
      ...cleanedReviewData,
      report_id: generateReportId(),
      date: new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      })
    };

    renderReviewReport(reportData, templatePath, typstPath);

    logContent += `\n=== ${comprehensiveConfig.displayName} completed ===\n`;
    logContent += `JSON saved to: ${jsonPath}\n`;
    logContent += `Typst rendered to: ${typstPath}\n`;
    fs.writeFileSync(logFilePath, logContent, 'utf8');

    const duration = Date.now() - startTime;
    StatusDisplay.printSuccess(`${comprehensiveConfig.displayName} (${(duration / 1000).toFixed(1)}s)`);
    StatusDisplay.printSuccess(`Report generated: ${typstPath}`);

    return {
      name: comprehensiveConfig.displayName,
      success: true,
      duration,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logContent += `\nError: ${errorMessage}\n`;
    fs.writeFileSync(logFilePath, logContent, 'utf8');

    StatusDisplay.printError(comprehensiveConfig.displayName, errorMessage);

    return {
      name: comprehensiveConfig.displayName,
      success: false,
      error: errorMessage,
      duration: Date.now() - startTime,
    };
  }
}
