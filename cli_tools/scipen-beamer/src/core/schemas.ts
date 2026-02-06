/**
 * Zod Schemas for Structured Outputs
 * 
 * These schemas define the strict JSON structure that each agent must output.
 * The SDK will validate agent outputs against these schemas.
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// ============================================================================
// Paper Analysis Schema
// ============================================================================

/**
 * Extracted metadata from a paper
 */
const PaperMetadataSchema = z.object({
  title: z.string().describe('Paper title (clean, without LaTeX commands)'),
  authors: z.array(z.string()).describe('List of authors'),
  affiliations: z.array(z.string()).optional().describe('Author affiliations'),
  abstract: z.string().describe('Paper abstract (100-200 words)'),
  keywords: z.array(z.string()).optional().describe('Paper keywords'),
  venue: z.string().optional().describe('Publication venue'),
  year: z.number().optional().describe('Publication year'),
});

/**
 * Section information extracted from paper
 */
const SectionInfoSchema = z.object({
  title: z.string().describe('Section title'),
  level: z.number().describe('Section level (1=main, 2=subsection, etc.)'),
  importance: z.enum(['high', 'medium', 'low']).describe('Importance for presentation'),
  keyPoints: z.array(z.string()).describe('Key points from this section'),
  hasEquations: z.boolean().describe('Whether section contains important equations'),
  hasFigures: z.boolean().describe('Whether section contains figures'),
});

/**
 * Contribution/innovation identified in paper
 */
const ContributionSchema = z.object({
  title: z.string().describe('Short title for the contribution'),
  description: z.string().describe('Description of the contribution'),
  isNovel: z.boolean().describe('Whether this is a novel contribution'),
  category: z.enum(['method', 'theory', 'experiment', 'application', 'other']),
});

/**
 * Complete Paper Analysis output
 */
export const PaperAnalysisSchema = z.object({
  metadata: PaperMetadataSchema,
  sections: z.array(SectionInfoSchema).describe('Analyzed sections of the paper'),
  contributions: z.array(ContributionSchema).describe('Main contributions'),
  technicalDepth: z.enum(['high', 'medium', 'low']).describe('Technical complexity level'),
  keyEquations: z.array(z.string()).optional().describe('Important equations to include'),
  keyFigures: z.array(z.object({
    path: z.string().optional(),
    caption: z.string(),
    importance: z.enum(['essential', 'useful', 'optional']),
  })).optional().describe('Important figures'),
  summary: z.string().describe('2-3 paragraph summary of the paper'),
  presentationNotes: z.string().optional().describe('Notes for presentation creation'),
});

export type PaperAnalysis = z.infer<typeof PaperAnalysisSchema>;

// ============================================================================
// Presentation Plan Schema
// ============================================================================

/**
 * Single slide specification
 */
const SlideSpecSchema = z.object({
  slideNumber: z.number().describe('Slide number (1-indexed)'),
  title: z.string().describe('Slide title (4-8 words)'),
  type: z.enum(['title', 'outline', 'motivation', 'method', 'results', 'conclusion', 'content', 'thankyou']),
  section: z.string().optional().describe('Section this slide belongs to'),
  contentPoints: z.array(z.string()).describe('3-5 bullet points for this slide'),
  speakingNotes: z.string().optional().describe('Notes for presenter'),
  includeEquation: z.boolean().optional().describe('Whether to include an equation'),
  includeFigure: z.boolean().optional().describe('Whether to include a figure'),
  estimatedMinutes: z.number().describe('Estimated speaking time in minutes'),
  priority: z.enum(['must-include', 'important', 'optional']).describe('Content priority'),
});

/**
 * Section grouping for slides
 */
const SectionPlanSchema = z.object({
  sectionName: z.string(),
  slideCount: z.number(),
  estimatedMinutes: z.number(),
});

/**
 * Complete Presentation Plan output
 */
export const PresentationPlanSchema = z.object({
  totalSlides: z.number().describe('Total number of slides'),
  totalDuration: z.number().describe('Total estimated duration in minutes'),
  sections: z.array(SectionPlanSchema).describe('Section breakdown'),
  slides: z.array(SlideSpecSchema).describe('Detailed slide specifications'),
  narrativeFlow: z.string().describe('Description of the presentation flow'),
  timingCheckpoints: z.array(z.object({
    slideNumber: z.number(),
    expectedMinutes: z.number(),
    note: z.string(),
  })).optional().describe('Timing checkpoints'),
});

export type PresentationPlan = z.infer<typeof PresentationPlanSchema>;

// ============================================================================
// Beamer Code Schema
// ============================================================================

/**
 * Generated Beamer LaTeX code
 */
export const BeamerCodeSchema = z.object({
  latexCode: z.string().describe('Complete Beamer LaTeX document'),
  usesChineseSupport: z.boolean().describe('Whether CJK/Chinese support is needed'),
  packagesUsed: z.array(z.string()).describe('LaTeX packages used'),
  slideCount: z.number().describe('Number of slides generated'),
  warnings: z.array(z.string()).optional().describe('Any warnings or notes about the code'),
});

export type BeamerCode = z.infer<typeof BeamerCodeSchema>;

// ============================================================================
// Compilation Fix Schema
// ============================================================================

/**
 * Error analysis from LaTeX compilation
 */
const LatexErrorSchema = z.object({
  line: z.number().optional().describe('Line number where error occurred'),
  errorType: z.string().describe('Type of LaTeX error'),
  message: z.string().describe('Error message'),
  context: z.string().optional().describe('Code context around the error'),
  suggestedFix: z.string().describe('Suggested fix for this error'),
});

/**
 * Compilation fix output
 */
export const CompilationFixSchema = z.object({
  errorsAnalyzed: z.array(LatexErrorSchema).describe('Errors that were analyzed'),
  fixedCode: z.string().describe('Complete fixed LaTeX code'),
  changesSummary: z.array(z.string()).describe('Summary of changes made'),
  confidence: z.enum(['high', 'medium', 'low']).describe('Confidence in the fix'),
});

export type CompilationFix = z.infer<typeof CompilationFixSchema>;

// ============================================================================
// JSON Schema Exports (for SDK outputFormat)
// ============================================================================

// Use type assertion to work around zod-to-json-schema type compatibility issues
export const paperAnalysisJsonSchema = zodToJsonSchema(PaperAnalysisSchema as any, {
  $refStrategy: 'none',
  target: 'jsonSchema7',
});

export const presentationPlanJsonSchema = zodToJsonSchema(PresentationPlanSchema as any, {
  $refStrategy: 'none',
  target: 'jsonSchema7',
});

export const beamerCodeJsonSchema = zodToJsonSchema(BeamerCodeSchema as any, {
  $refStrategy: 'none',
  target: 'jsonSchema7',
});

export const compilationFixJsonSchema = zodToJsonSchema(CompilationFixSchema as any, {
  $refStrategy: 'none',
  target: 'jsonSchema7',
});

