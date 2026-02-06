/**
 * @file mainController.ts - Main controller
 * @description Orchestrates Paper-to-Beamer generation pipeline
 * @depends path, fs, os, templateManager, statusDisplay, sdk, agents, schemas
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { TemplateManager, type TemplateConfig } from '../utils/templateManager.js';
import { StatusDisplay } from '../utils/statusDisplay.js';
import {
  executeQuery,
  createAgentContext,
  extractStructuredOutput,
  ensureOutputDirs,
  hasLatexCompiler,
  compileLatex,
  type OutputFormat,
  type SDKMessage,
} from './sdk.js';
import {
  allAgents,
  agentTaskConfigs,
} from '../agents/definitions.js';
import {
  paperAnalysisJsonSchema,
  presentationPlanJsonSchema,
  beamerCodeJsonSchema,
  compilationFixJsonSchema,
  type PaperAnalysis,
  type PresentationPlan,
  type BeamerCode,
  type CompilationFix,
} from './schemas.js';

/** Get SciPen global directory (~/.scipen) */
export function getScipenHomeDir(): string {
  return path.join(os.homedir(), '.scipen');
}

export interface GenerateOptions {
  outputDir?: string;
  outputFile?: string;
  duration?: number;
  useCustomTemplate?: boolean;
  customTemplatePath?: string;
  skipCompilation?: boolean;
  maxCompilationRetries?: number;
}

/** Generation result */
export interface GenerateResult {
  success: boolean;
  texPath: string;
  pdfPath?: string;
  outputDir: string;
  message: string;
  analysis?: PaperAnalysis;
  plan?: PresentationPlan;
  compilationAttempts?: number;
}

/** Main controller */
export class MainController {
  private templateManager: TemplateManager;

  constructor() {
    this.templateManager = new TemplateManager();
  }

  /**
   * Execute complete generation pipeline: analysis -> planning -> generation -> compilation
   */
  async generate(
    paperTexPath: string,
    options: GenerateOptions = {}
  ): Promise<GenerateResult> {
    const defaultOutputDir = path.join(getScipenHomeDir(), 'beamer');

    const {
      outputDir: baseOutputDir = defaultOutputDir,
      outputFile,
      duration = 15,
      useCustomTemplate = false,
      customTemplatePath,
      skipCompilation = false,
      maxCompilationRetries = 3,
    } = options;

    const absolutePaperPath = path.resolve(paperTexPath);
    let outputDir: string;
    let texPath: string;

    if (outputFile) {
      const normalizedOutputFile = path.resolve(outputFile);
      const ext = path.extname(normalizedOutputFile);
      const finalOutputFile = ext ? normalizedOutputFile : `${normalizedOutputFile}.tex`;
      outputDir = path.dirname(finalOutputFile);
      texPath = finalOutputFile;
    } else {
      const normalizedBaseDir = path.resolve(baseOutputDir);
      const rawPaperName = path.basename(paperTexPath, '.tex');
      const paperName = rawPaperName.replace(/[<>:"|?*]/g, '-');
      outputDir = path.join(normalizedBaseDir, paperName);
      texPath = path.join(outputDir, 'presentation.tex');
    }

    const templateConfig = this.templateManager.createTemplateConfig(
      useCustomTemplate ? customTemplatePath : undefined
    );

    StatusDisplay.printHeader('SciPen Beamer - Paper to Presentation');
    StatusDisplay.printFileInfo('Input Paper', absolutePaperPath);
    StatusDisplay.printFileInfo('Output Directory', outputDir);

    if (templateConfig.useCustomTemplate && templateConfig.templatePath) {
      StatusDisplay.printFileInfo('Custom Template', this.templateManager.getTemplateName(templateConfig.templatePath));
    } else {
      console.log(`${StatusDisplay.Colors.BLUE}Theme:${StatusDisplay.Colors.NC} Boadilla (default)`);
    }

    try {
      const dirs = ensureOutputDirs(outputDir);
      const writeLog = (logFileName: string, content: string) => {
        const logPath = path.join(dirs.logDir, logFileName);
        fs.appendFileSync(logPath, content, 'utf8');
      };

      // === Stage 1: Paper Analysis ===
      StatusDisplay.printPhase('Stage 1: Paper Analysis');
      StatusDisplay.printStart(agentTaskConfigs.analysis.displayName);

      const analysisLogFile = agentTaskConfigs.analysis.logFileName;
      writeLog(analysisLogFile, `=== Paper Analysis Started ===\n`);
      writeLog(analysisLogFile, `Time: ${new Date().toISOString()}\n`);
      writeLog(analysisLogFile, `Paper: ${absolutePaperPath}\n`);
      writeLog(analysisLogFile, `Output: ${outputDir}\n\n`);

      const startAnalysis = Date.now();
      const paperDir = path.dirname(absolutePaperPath);
      const analysisContext = createAgentContext(allAgents, [paperDir]);

      const outputFormatAnalysis: OutputFormat = {
        type: 'json_schema',
        schema: paperAnalysisJsonSchema as Record<string, unknown>,
      };

      const analysisPrompt = `Analyze this paper ${absolutePaperPath} for creating a presentation. Extract key information including title, authors, affiliations, abstract, keywords, section structure, key points, main contributions, innovations, important equations, figures, and results.

CRITICAL: You MUST respond with valid JSON only. Do NOT include any explanatory text, markdown formatting, or natural language before or after the JSON. Your entire response must be a single JSON object that matches the required schema.`;

      writeLog(analysisLogFile, `Prompt:\n${analysisPrompt}\n\n`);
      writeLog(analysisLogFile, `--- SDK Call Started (Real-time Log) ---\n`);

      const analysisResult = await executeQuery(
        analysisPrompt,
        {
          ...analysisContext,
          cwd: paperDir,
          outputFormat: outputFormatAnalysis,
          onMessage: (msg) => {
            const timestamp = new Date().toISOString();
            writeLog(analysisLogFile, `[${timestamp}] [${msg.type}] ${JSON.stringify(msg).substring(0, 500)}\n`);
          },
        }
      );

      writeLog(analysisLogFile, `\n--- SDK Call Ended ---\n`);
      writeLog(analysisLogFile, `Result preview: ${analysisResult.result.substring(0, 500)}...\n\n`);

      const analysis = extractStructuredOutput<PaperAnalysis>(
        analysisResult.structuredOutput,
        analysisResult.result,
        'Paper Analysis Agent output'
      );

      fs.writeFileSync(
        path.join(dirs.jsonDir, 'paper-analysis.json'),
        JSON.stringify(analysis, null, 2),
        'utf8'
      );

      const analysisDuration = Date.now() - startAnalysis;
      writeLog(analysisLogFile, `=== Paper Analysis Completed (${(analysisDuration / 1000).toFixed(1)}s) ===\n`);
      writeLog(analysisLogFile, `Title: ${analysis.metadata.title}\n`);
      writeLog(analysisLogFile, `Sections: ${analysis.sections.length}\n`);
      writeLog(analysisLogFile, `Contributions: ${analysis.contributions.length}\n`);

      StatusDisplay.printSuccess(`${agentTaskConfigs.analysis.displayName} (${(analysisDuration / 1000).toFixed(1)}s)`);
      console.log(`  Title: ${analysis.metadata.title}`);
      console.log(`  Sections: ${analysis.sections.length}`);
      console.log(`  Contributions: ${analysis.contributions.length}`);

      // === Stage 2: Presentation Planning ===
      StatusDisplay.printPhase('Stage 2: Presentation Planning');
      StatusDisplay.printStart(agentTaskConfigs.planning.displayName);

      const planningLogFile = agentTaskConfigs.planning.logFileName;
      writeLog(planningLogFile, `=== Presentation Planning Started ===\n`);
      writeLog(planningLogFile, `Time: ${new Date().toISOString()}\n`);
      writeLog(planningLogFile, `Duration: ${duration} minutes\n`);
      writeLog(planningLogFile, `Paper Title: ${analysis.metadata.title}\n\n`);

      const startPlanning = Date.now();
      const planContext = createAgentContext(allAgents, [paperDir]);

      const outputFormatPlan: OutputFormat = {
        type: 'json_schema',
        schema: presentationPlanJsonSchema as Record<string, unknown>,
      };

      const planPrompt = `Based on the following paper analysis, create a detailed presentation plan for a ${duration}-minute presentation. Include slide titles, slide types, key points per slide, timing checkpoints, and section breakdown.

Paper Analysis:
${JSON.stringify(analysis, null, 2)}

CRITICAL: You MUST respond with valid JSON only. Do NOT include any explanatory text, markdown formatting, or natural language before or after the JSON. Your entire response must be a single JSON object that matches the required schema.`;

      writeLog(planningLogFile, `Prompt:\n${planPrompt}\n\n`);
      writeLog(planningLogFile, `--- SDK Call Started (Real-time Log) ---\n`);

      const planResult = await executeQuery(
        planPrompt,
        {
          ...planContext,
          cwd: paperDir,
          outputFormat: outputFormatPlan,
          onMessage: (msg) => {
            const timestamp = new Date().toISOString();
            writeLog(planningLogFile, `[${timestamp}] [${msg.type}] ${JSON.stringify(msg).substring(0, 500)}\n`);
          },
        }
      );

      writeLog(planningLogFile, `\n--- SDK Call Ended ---\n`);
      writeLog(planningLogFile, `Result preview: ${planResult.result.substring(0, 500)}...\n\n`);

      const plan = extractStructuredOutput<PresentationPlan>(
        planResult.structuredOutput,
        planResult.result,
        'Presentation Planner Agent output'
      );

      fs.writeFileSync(
        path.join(dirs.jsonDir, 'presentation-plan.json'),
        JSON.stringify(plan, null, 2),
        'utf8'
      );

      const planDuration = Date.now() - startPlanning;
      writeLog(planningLogFile, `=== Presentation Planning Completed (${(planDuration / 1000).toFixed(1)}s) ===\n`);
      writeLog(planningLogFile, `Total Slides: ${plan.totalSlides}\n`);
      writeLog(planningLogFile, `Total Duration: ${plan.totalDuration} minutes\n`);

      StatusDisplay.printSuccess(`${agentTaskConfigs.planning.displayName} (${(planDuration / 1000).toFixed(1)}s)`);
      console.log(`  Total Slides: ${plan.totalSlides}`);
      console.log(`  Presentation Duration: ${plan.totalDuration} minutes`);

      // === Stage 3: Beamer Code Generation ===
      StatusDisplay.printPhase('Stage 3: Beamer Code Generation');
      StatusDisplay.printStart(agentTaskConfigs.generation.displayName);

      const generationLogFile = agentTaskConfigs.generation.logFileName;
      writeLog(generationLogFile, `=== Beamer Generation Started ===\n`);
      writeLog(generationLogFile, `Time: ${new Date().toISOString()}\n`);
      writeLog(generationLogFile, `Use Custom Template: ${templateConfig.useCustomTemplate}\n`);
      if (templateConfig.templatePath) {
        writeLog(generationLogFile, `Template Path: ${templateConfig.templatePath}\n`);
      }
      writeLog(generationLogFile, `\n`);

      const startGeneration = Date.now();
      const genContext = createAgentContext(allAgents, [paperDir]);

      const outputFormatGen: OutputFormat = {
        type: 'json_schema',
        schema: beamerCodeJsonSchema as Record<string, unknown>,
      };

      let templateContext = '';
      if (templateConfig.useCustomTemplate && templateConfig.templatePath) {
        const templateContent = fs.readFileSync(templateConfig.templatePath, 'utf8');
        templateContext = `\n\nUse the following custom template as the basis:\n\`\`\`latex\n${templateContent}\n\`\`\``;
      }

      const generationPrompt = `Generate a complete, compilable Beamer LaTeX presentation. Provide the complete LaTeX code, package list, slide count, and any warnings.

Paper Analysis:
${JSON.stringify(analysis, null, 2)}

Presentation Plan:
${JSON.stringify(plan, null, 2)}
${templateContext}

CRITICAL: You MUST respond with valid JSON only. Do NOT include any explanatory text, markdown formatting, or natural language before or after the JSON. Your entire response must be a single JSON object that matches the required schema.`;

      writeLog(generationLogFile, `Prompt:\n${generationPrompt}\n\n`);
      writeLog(generationLogFile, `--- SDK Call Started (Real-time Log) ---\n`);

      const generationResult = await executeQuery(
        generationPrompt,
        {
          ...genContext,
          cwd: paperDir,
          outputFormat: outputFormatGen,
          onMessage: (msg) => {
            const timestamp = new Date().toISOString();
            writeLog(generationLogFile, `[${timestamp}] [${msg.type}] ${JSON.stringify(msg).substring(0, 500)}\n`);
          },
        }
      );

      writeLog(generationLogFile, `\n--- SDK Call Ended ---\n`);
      writeLog(generationLogFile, `Result preview: ${generationResult.result.substring(0, 500)}...\n\n`);

      const beamerCode = extractStructuredOutput<BeamerCode>(
        generationResult.structuredOutput,
        generationResult.result,
        'Beamer Generator Agent output'
      );

      fs.writeFileSync(texPath, beamerCode.latexCode, 'utf8');

      if (templateConfig.useCustomTemplate && templateConfig.styleFiles.length > 0) {
        for (const styleFile of templateConfig.styleFiles) {
          if (styleFile.exists) {
            const targetPath = path.join(outputDir, path.basename(styleFile.path));
            fs.copyFileSync(styleFile.path, targetPath);
            console.log(`  Copied style: ${styleFile.name}.sty`);
            writeLog(generationLogFile, `Copied style file: ${styleFile.name}.sty\n`);
          }
        }
      }

      const genDuration = Date.now() - startGeneration;
      writeLog(generationLogFile, `=== Beamer Generation Completed (${(genDuration / 1000).toFixed(1)}s) ===\n`);
      writeLog(generationLogFile, `Slide Count: ${beamerCode.slideCount}\n`);
      writeLog(generationLogFile, `Uses Chinese: ${beamerCode.usesChineseSupport}\n`);
      writeLog(generationLogFile, `Packages: ${beamerCode.packagesUsed.join(', ')}\n`);

      StatusDisplay.printSuccess(`${agentTaskConfigs.generation.displayName} (${(genDuration / 1000).toFixed(1)}s)`);
      console.log(`  Slide Count: ${beamerCode.slideCount}`);

      // === Stage 4: Compilation (Optional) ===
      let pdfPath: string | undefined;
      let compilationAttempts = 0;
      const fixingLogFile = agentTaskConfigs.fixing.logFileName;

      if (!skipCompilation && hasLatexCompiler()) {
        StatusDisplay.printPhase('Stage 4: LaTeX Compilation');
        StatusDisplay.printStart('Compiling xelatex');

        writeLog(fixingLogFile, `=== LaTeX Compilation Started ===\n`);
        writeLog(fixingLogFile, `Time: ${new Date().toISOString()}\n`);
        writeLog(fixingLogFile, `TeX Path: ${texPath}\n`);
        writeLog(fixingLogFile, `Max Retries: ${maxCompilationRetries}\n\n`);

        let currentTexContent = beamerCode.latexCode;
        let compileSuccess = false;

        for (let attempt = 1; attempt <= maxCompilationRetries; attempt++) {
          compilationAttempts = attempt;
          console.log(`  Attempt ${attempt}/${maxCompilationRetries}...`);
          writeLog(fixingLogFile, `--- Compilation Attempt ${attempt}/${maxCompilationRetries} ---\n`);

          const compileResult = compileLatex(texPath, outputDir);

          if (compileResult.success && compileResult.pdfPath) {
            pdfPath = compileResult.pdfPath;
            compileSuccess = true;
            writeLog(fixingLogFile, `Compilation successful! PDF: ${pdfPath}\n`);
            StatusDisplay.printSuccess('Compilation successful');
            break;
          }

          writeLog(fixingLogFile, `Compilation failed: ${compileResult.errorSummary || 'Unknown error'}\n`);

          if (attempt < maxCompilationRetries) {
            StatusDisplay.printWarning('Compilation failed, attempting automatic fix...');
            writeLog(fixingLogFile, `Attempting automatic fix...\n`);

            const fixContext = createAgentContext(allAgents, [paperDir]);
            const outputFormatFix: OutputFormat = {
              type: 'json_schema',
              schema: compilationFixJsonSchema as Record<string, unknown>,
            };

            const fixPrompt = `The following LaTeX code failed to compile. Analyze the errors and provide the complete fixed LaTeX code with analyzed errors, changes summary, and confidence level.

LaTeX Code:
\`\`\`latex
${currentTexContent}
\`\`\`

Compilation Errors:
${compileResult.errorSummary || 'Unknown error'}

Full Log (excerpt):
${compileResult.logContent?.slice(0, 5000) || 'No log available'}

CRITICAL: You MUST respond with valid JSON only. Do NOT include any explanatory text, markdown formatting, or natural language before or after the JSON. Your entire response must be a single JSON object that matches the required schema.`;

            writeLog(fixingLogFile, `Fix Prompt:\n${fixPrompt.substring(0, 1000)}...\n\n`);
            writeLog(fixingLogFile, `--- Fix SDK Call Started (Real-time Log) ---\n`);

            const fixResult = await executeQuery(
              fixPrompt,
              {
                ...fixContext,
                cwd: paperDir,
                outputFormat: outputFormatFix,
                onMessage: (msg) => {
                  const timestamp = new Date().toISOString();
                  writeLog(fixingLogFile, `[${timestamp}] [${msg.type}] ${JSON.stringify(msg).substring(0, 500)}\n`);
                },
              }
            );

            writeLog(fixingLogFile, `\n--- Fix SDK Call Ended ---\n`);

            try {
              const fix = extractStructuredOutput<CompilationFix>(
                fixResult.structuredOutput,
                fixResult.result,
                'Compilation Fixer Agent output'
              );

              currentTexContent = fix.fixedCode;
              fs.writeFileSync(texPath, currentTexContent, 'utf8');
              console.log(`  Applied ${fix.changesSummary.length} fixes`);
              writeLog(fixingLogFile, `Applied ${fix.changesSummary.length} fixes:\n`);
              fix.changesSummary.forEach((change, i) => {
                writeLog(fixingLogFile, `  ${i + 1}. ${change}\n`);
              });
            } catch (e) {
              const errorMsg = e instanceof Error ? e.message : String(e);
              writeLog(fixingLogFile, `Automatic fix failed: ${errorMsg}\n`);
              StatusDisplay.printError('Automatic fix', errorMsg);
            }
          }
        }

        if (!compileSuccess) {
          writeLog(fixingLogFile, `\nAll compilation attempts failed\n`);
          StatusDisplay.printWarning('Compilation failed, please compile manually');
        }

        writeLog(fixingLogFile, `\n=== LaTeX Compilation Ended ===\n`);
      } else if (!skipCompilation) {
        console.log();
        writeLog(fixingLogFile, `xelatex not detected, skipping compilation\n`);
        StatusDisplay.printWarning('xelatex not detected, skipping compilation');
        console.log('  Please compile manually or upload to Overleaf');
      }

      // === Complete ===
      StatusDisplay.printHeader('Generation Complete');
      StatusDisplay.printFileInfo('TeX File', texPath);
      if (pdfPath) {
        StatusDisplay.printFileInfo('PDF File', pdfPath);
      } else {
        const texFileName = path.basename(texPath);
        console.log(
          `\n${StatusDisplay.Colors.YELLOW}Compilation command: cd "${outputDir}" && xelatex ${texFileName}${StatusDisplay.Colors.NC}\n`
        );
      }

      return {
        success: true,
        texPath,
        pdfPath,
        outputDir,
        message: pdfPath
          ? 'Beamer presentation generated and compiled successfully'
          : 'Beamer presentation generated (pending compilation)',
        analysis,
        plan,
        compilationAttempts,
      };
    } catch (error: any) {
      StatusDisplay.printError('Generation failed', error.message);
      throw error;
    }
  }
}
