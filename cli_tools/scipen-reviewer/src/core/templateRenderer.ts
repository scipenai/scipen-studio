/**
 * @file templateRenderer.ts - Typst template renderer
 * @description Renders Typst reports using Handlebars template engine
 * @depends fs, path, handlebars, schemas
 */

import * as fs from 'fs';
import * as path from 'path';
import Handlebars from 'handlebars';
import type {
  ReviewData,
  EnglishQualityData,
  PaperAnalysisData,
  ExperimentalEvaluationData,
  TechnicalEvaluationData,
  LiteratureReviewData
} from './schemas.js';

/**
 * Typst escape function
 *
 * Special characters that need escaping in Typst:
 * - Backslash: \ -> \\
 * - Hash: # -> \#
 * - Asterisk: * -> \*
 * - Underscore: _ -> \_
 * - @ symbol: @ -> \@
 * - Dollar sign: $ -> \$
 * - Backtick: ` -> \`
 * - Angle brackets: < > -> \< \>
 */
// Export latexEscape as alias for typstEscape, maintain backward compatibility
export const latexEscape = typstEscape;

export function typstEscape(text: unknown): string {
  // Handle null, undefined, empty string
  if (text === null || text === undefined || text === '') return '';

  // Ensure string type
  const str = typeof text === 'string' ? text : String(text);

  return str
    // 1. Escape backslash first
    .replace(/\\/g, '\\\\')
    // 2. Escape hash (function calls, headings)
    .replace(/#/g, '\\#')
    // 3. Escape asterisk (bold)
    .replace(/\*/g, '\\*')
    // 4. Escape underscore (italic)
    .replace(/_/g, '\\_')
    // 5. Escape @ symbol (references)
    .replace(/@/g, '\\@')
    // 6. Escape dollar sign (math mode)
    .replace(/\$/g, '\\$')
    // 7. Escape backtick (raw text)
    .replace(/`/g, '\\`')
    // 8. Escape angle brackets
    .replace(/</g, '\\<')
    .replace(/>/g, '\\>');
}

/**
 * Register Handlebars helpers
 */
function registerHelpers(): void {
  // Typst escape helper
  Handlebars.registerHelper('typst_escape', function(text: string) {
    return new Handlebars.SafeString(typstEscape(text));
  });

  // Keep latex_escape as alias for compatibility
  Handlebars.registerHelper('latex_escape', function(text: string) {
    return new Handlebars.SafeString(typstEscape(text));
  });

  // Helper for debugging
  Handlebars.registerHelper('debug', function(value: unknown) {
    console.log('Handlebars Debug:', value);
    return '';
  });
}

// Register helpers (executed once when module loads)
registerHelpers();

/**
 * Template renderer class
 * Uses Handlebars for template rendering
 */
export class TemplateRenderer {
  private compiledTemplate: Handlebars.TemplateDelegate;

  constructor(templatePath: string) {
    const templateSource = fs.readFileSync(templatePath, 'utf8');
    // Pre-compile template for better performance
    this.compiledTemplate = Handlebars.compile(templateSource, {
      strict: false, // Allow access to non-existent properties
      noEscape: true, // Do not auto-escape (Typst requires manual escape control)
    });
  }

  /**
   * Render template
   */
  render(data: Record<string, unknown>): string {
    return this.compiledTemplate(data);
  }
}

/**
 * Review report data interface
 * Extends ReviewData, adds additional fields needed for report generation
 */
export interface ReviewReportData extends ReviewData {
  report_id: string;
  date: string;
}

/**
 * Generate report ID
 */
export function generateReportId(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `SP-${year}-${month}-${random}`;
}

// Report data interface definitions
export interface ReviewReportData extends ReviewData { report_id: string; date: string; }
export interface EnglishQualityReportData extends EnglishQualityData { report_id: string; date: string; }
export interface PaperAnalysisReportData extends PaperAnalysisData { report_id: string; date: string; }
export interface ExperimentalEvaluationReportData extends ExperimentalEvaluationData { report_id: string; date: string; }
export interface TechnicalEvaluationReportData extends TechnicalEvaluationData { report_id: string; date: string; }
export interface LiteratureReviewReportData extends LiteratureReviewData { report_id: string; date: string; }

/**
 * Generic report rendering function
 */
function renderTypstReport(
  data: unknown,
  templatePath: string,
  outputPath: string
): void {
  const renderer = new TemplateRenderer(templatePath);
  const renderedTypst = renderer.render(data as Record<string, unknown>);
  fs.writeFileSync(outputPath, renderedTypst, 'utf8');
}

// Type-safe rendering functions
export function renderReviewReport(data: ReviewReportData, templatePath: string, outputPath: string): void {
  renderTypstReport(data, templatePath, outputPath);
}
export function renderEnglishQualityReport(data: EnglishQualityReportData, templatePath: string, outputPath: string): void {
  renderTypstReport(data, templatePath, outputPath);
}
export function renderPaperAnalysisReport(data: PaperAnalysisReportData, templatePath: string, outputPath: string): void {
  renderTypstReport(data, templatePath, outputPath);
}
export function renderExperimentalEvaluationReport(data: ExperimentalEvaluationReportData, templatePath: string, outputPath: string): void {
  renderTypstReport(data, templatePath, outputPath);
}
export function renderTechnicalEvaluationReport(data: TechnicalEvaluationReportData, templatePath: string, outputPath: string): void {
  renderTypstReport(data, templatePath, outputPath);
}
export function renderLiteratureReviewReport(data: LiteratureReviewReportData, templatePath: string, outputPath: string): void {
  renderTypstReport(data, templatePath, outputPath);
}
