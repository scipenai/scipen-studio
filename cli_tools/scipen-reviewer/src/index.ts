/**
 * @file index.ts - SciPen - Scientific Paper Review System (SDK Version)
 * @description A multi-agent paper review framework based on Claude Agent SDK
 * @packageDocumentation
 *
 * Features:
 * - Pure code-defined agents, no file system configuration needed
 * - Supports PDF, DOC, DOCX and other formats (via Mineru API conversion)
 * - Parallel multi-agent evaluation
 * - Comprehensive review report generation
 */

// ============================================================================
// SDK Core
// ============================================================================
export {
  query,
  executeQuery,
  createAgentContext,
  SDKQueryError,
  type AgentDefinition,
  type SDKMessage,
  type SDKQueryOptions,
  type McpServerConfig,
  type McpStdioServerConfig,
  type McpSSEServerConfig,
  type McpHttpServerConfig,
  type McpSdkServerConfig,
} from './core/sdk.js';

// ============================================================================
// Core Functionality
// ============================================================================
export { Reviewer, reviewPaper, type ReviewerConfig } from './core/reviewer.js';
export type { ReviewConfig, ReviewResult, MineruApiConfig } from './core/types.js';

// ============================================================================
// File Preprocessing
// ============================================================================
export {
  FilePreprocessor,
  preprocessFile,
  isLatexFile,
  needsPreprocessing,
  getSupportedFormats,
  type PreprocessResult,
  type MineruConfig,
} from './core/filePreprocessor.js';

// ============================================================================
// Agent Definitions
// ============================================================================
export {
  allAgents,
  agentTaskConfigs,
  comprehensiveReviewConfig,
  paperAnalysisAgent,
  experimentalEvaluatorAgent,
  technicalPaperEvaluatorAgent,
  englishQualityAgent,
  literatureReviewEvaluatorAgent,
  comprehensiveReviewAgent,
  type AgentTaskConfig,
} from './agents/definitions.js';

// ============================================================================
// Template Rendering
// ============================================================================
export {
  TemplateRenderer,
  latexEscape,
  renderReviewReport,
  generateReportId,
  type ReviewReportData,
} from './core/templateRenderer.js';

// ============================================================================
// Utilities
// ============================================================================
export { StatusDisplay } from './utils/statusDisplay.js';

// ============================================================================
// Executors
// ============================================================================
export {
  executeParallelTasks,
  executeComprehensiveReview,
  type TaskResult,
  type ExecutorOptions,
} from './core/parallelExecutor.js';

// ============================================================================
// Schema Definitions
// ============================================================================
export {
  reviewDataSchema,
  type ReviewData,
} from './core/schemas.js';
