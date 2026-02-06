/**
 * @file vlm-converter.ts - VLM-based PDF to LaTeX converter
 * @description Orchestrates PDF extraction and VLM-based page-by-page conversion to LaTeX
 * @depends types, pdf-service, vlm-client, logger, fs, path, ora
 */

import type { ConversionOptions, LaTeXContent } from '../types';
import { PDFService } from '../services/pdf-service';
import { VLMClient } from '../services/vlm-client';
import { Logger } from '../utils/logger';
import * as fs from 'fs/promises';
import * as path from 'path';
import ora from 'ora';

export class VLMConverter {
  async convert(options: ConversionOptions): Promise<void> {
    const pdfService = new PDFService();
    const vlmClient = new VLMClient(options.baseURL, options.apiKey, options.model, {
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      timeout: options.timeout,
    });

    const spinner = ora('Extracting PDF pages...').start();
    const pages = await pdfService.extractPages(options.input, options.dpi || 300);
    spinner.succeed(`Successfully extracted ${pages.length} pages`);
    const concurrent = options.concurrent || 3;
    const results: LaTeXContent[] = [];
    const totalPages = pages.length;

    Logger.info(`Starting conversion of ${totalPages} pages, concurrent: ${concurrent}`);
    spinner.start('Converting pages...');

    let successCount = 0;
    let failureCount = 0;

    for (let i = 0; i < pages.length; i += concurrent) {
      const batch = pages.slice(i, i + concurrent);
      const batchStartPage = i + 1;
      const batchEndPage = Math.min(i + concurrent, pages.length);

      spinner.text = `Processing pages ${batchStartPage}-${batchEndPage} of ${totalPages}...`;

      const promises = batch.map((page) =>
        vlmClient
          .convertPageToLaTeX(page, options.maxRetries || 2)
          .then((content) => {
            successCount++;
            return {
              pageNumber: page.pageNumber,
              content,
            };
          })
          .catch((error) => {
            failureCount++;
            Logger.warning(`Page ${page.pageNumber} conversion failed: ${error.message}`);
            return {
              pageNumber: page.pageNumber,
              content: `% Conversion failed: ${error.message}`,
            };
          })
      );

      const batchResults = await Promise.all(promises);
      results.push(...batchResults);

      const processedPages = Math.min(i + concurrent, pages.length);
      const progress = ((processedPages / totalPages) * 100).toFixed(1);
      spinner.text = `Completed ${processedPages}/${totalPages} pages (${progress}%)`;
    }

    if (failureCount === 0) {
      spinner.succeed(`All ${totalPages} pages converted successfully!`);
    } else {
      spinner.warn(`Conversion completed: ${successCount} succeeded, ${failureCount} failed`);
    }

    Logger.info('Combining LaTeX content...');
    results.sort((a, b) => a.pageNumber - b.pageNumber);
    const combinedLaTeX = this.combinePages(results);

    Logger.info('Saving file...');
    await this.saveResult(combinedLaTeX, options.output);
  }

  private combinePages(pages: LaTeXContent[]): string {
    const contents = pages
      .map((page) => {
        const cleanedContent = this.cleanLatexContent(page.content);
        return `% Page ${page.pageNumber}\n${cleanedContent}\n\\clearpage\n`;
      })
      .join('\n');

    return `\\documentclass[12pt]{article}
\\usepackage{ctex}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath, amssymb}
\\usepackage{amsthm}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{hyperref}
\\usepackage{geometry}
\\usepackage{xcolor}

\\geometry{a4paper, margin=2.5cm}

\\begin{document}

${contents}

\\end{document}`;
  }

  private async saveResult(latex: string, outputPath: string): Promise<void> {
    const outputDir = path.dirname(outputPath);
    await fs.mkdir(outputDir, { recursive: true });

    await fs.writeFile(outputPath, latex, 'utf-8');
    Logger.success(`LaTeX saved to: ${outputPath}`);
  }

  private cleanLatexContent(content: string): string {
    return content
      .replace(/```(?:latex)?/g, '')
      .replace(/\\documentclass.*?\n/g, '')
      .replace(/\\usepackage.*?\n/g, '')
      .replace(/\\geometry.*?\n/g, '')
      .replace(/\\begin\{document\}/g, '')
      .replace(/\\end\{document\}/g, '')
      .replace(/\\includegraphics.*?\{[^}]*\}/g, '')
      .replace(/\\begin\{figure\}.*?\\end\{figure\}/gs, '')
      .replace(/\\begin\{center\}.*?\\includegraphics.*?\\end\{center\}/gs, '')
      .replace(/\\begin\{figure\}.*?\\caption\{[^}]*\}.*?\\end\{figure\}/gs, '')
      .replace(/\\ref\{[^}]*\}/g, '')
      .replace(/\n\s*\n\s*\n/g, '\n\n')
      .trim();
  }
}
