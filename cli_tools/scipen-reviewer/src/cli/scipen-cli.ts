#!/usr/bin/env node

/**
 * @file scipen-cli.ts - SciPen CLI
 * @description Command-line tool for scientific paper review system
 * @depends reviewer, filePreprocessor, statusDisplay
 *
 * Uses Claude Agent SDK pure code approach, no init command needed
 * Supports PDF, DOC, DOCX and other formats (via Mineru API conversion)
 */

import { Reviewer } from '../core/reviewer.js';
import { getSupportedFormats } from '../core/filePreprocessor.js';
import { StatusDisplay } from '../utils/statusDisplay.js';

const Colors = StatusDisplay.Colors;

function showHelp(): void {
  const formats = getSupportedFormats().join(', ');

  console.log(`${Colors.CYAN}SciPen - Scientific Paper Review System (SDK Version)${Colors.NC}`);
  console.log();
  console.log(`${Colors.YELLOW}Usage:${Colors.NC}`);
  console.log('  scipen review <paper-file>         Review the specified paper file');
  console.log('  scipen formats                     Show supported file formats');
  console.log('  scipen --help                      Show help information');
  console.log();
  console.log(`${Colors.YELLOW}Supported File Formats:${Colors.NC}`);
  console.log(`  ${formats}`);
  console.log();
  console.log(`${Colors.YELLOW}Environment Variables:${Colors.NC}`);
  console.log('  MINERU_API_TOKEN     Mineru API Token (for PDF/DOC conversion)');
  console.log('  AMINER_API_KEY       AMiner API key (for literature search)');
  console.log();
  console.log(`${Colors.YELLOW}Examples:${Colors.NC}`);
  console.log('  scipen review main.tex');
  console.log('  scipen review paper.pdf');
  console.log();
  console.log(`${Colors.YELLOW}Output Directory:${Colors.NC}`);
  console.log('  ~/.scipen/reviewer/<paper-name>/');
  console.log('    ├── converted/   Converted LaTeX files');
  console.log('    ├── log/         Execution logs');
  console.log('    ├── json/        Structured data');
  console.log('    └── reports/     Review reports');
}

function showFormats(): void {
  console.log(`${Colors.CYAN}Supported File Formats:${Colors.NC}`);
  console.log();
  console.log(`${Colors.GREEN}Directly Supported (No Conversion Needed):${Colors.NC}`);
  console.log('  .tex, .latex .md');
  console.log();
  console.log(`${Colors.YELLOW}Requires Conversion (MINERU_API_TOKEN Required):${Colors.NC}`);
  console.log('  .pdf, .doc, .docx, .ppt, .pptx, .png, .jpg, .jpeg');
}

async function reviewCommand(args: string[]): Promise<void> {
  const paperFile = args[0];

  // Check environment variables
  const mineruApiToken = process.env.MINERU_API_TOKEN;
  const aminerApiKey = process.env.AMINER_API_KEY;

  // Display environment variable status
  console.log();
  console.log(`${Colors.CYAN}Environment Configuration:${Colors.NC}`);

  if (mineruApiToken) {
    console.log(`  ${Colors.GREEN}✔${Colors.NC} MINERU_API_TOKEN is set (PDF/DOC conversion supported)`);
  } else {
    console.log(`  ${Colors.YELLOW}○${Colors.NC} MINERU_API_TOKEN not set (LaTeX files only)`);
  }

  if (aminerApiKey) {
    console.log(`  ${Colors.GREEN}✔${Colors.NC} AMINER_API_KEY is set (literature search enabled)`);
  } else {
    console.log(`  ${Colors.YELLOW}○${Colors.NC} AMINER_API_KEY not set (literature review evaluation limited)`);
  }

  console.log();

  const reviewer = new Reviewer({
    aminerApiKey,
    mineruApiToken,
  });

  try {
    const result = await reviewer.review({
      paperFile,
    });

    if (result.success) {
      console.log(`${Colors.GREEN}✔ Review completed${Colors.NC}`);
      if (result.outputDir) {
        console.log(`${Colors.GREEN}  Output directory: ${result.outputDir}${Colors.NC}`);
      }
      if (result.reportPath) {
        console.log(`${Colors.GREEN}  Final report: ${result.reportPath}${Colors.NC}`);
      }
      if (result.preprocessInfo?.isConverted) {
        console.log(`${Colors.CYAN}  Original file: ${result.preprocessInfo.originalFile}${Colors.NC}`);
        console.log(`${Colors.CYAN}  Converted file: ${result.preprocessInfo.processedFile}${Colors.NC}`);
      }
    } else {
      console.log(`${Colors.YELLOW}⚠ Review completed, but some tasks failed${Colors.NC}`);
      if (result.errors && result.errors.length > 0) {
        console.log(`${Colors.RED}Errors:${Colors.NC}`);
        for (const error of result.errors) {
          console.log(`  - ${error}`);
        }
      }
      process.exit(1);
    }
  } catch (error: any) {
    console.error(`${Colors.RED}Review failed:${Colors.NC}`, error.message);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    showHelp();
    process.exit(1);
  }

  const command = args[0];

  switch (command) {
    case 'review':
      if (args.length < 2) {
        console.log(`${Colors.RED}Error: review command requires a paper file${Colors.NC}`);
        console.log(`${Colors.YELLOW}Usage: scipen review <paper-file>${Colors.NC}`);
        console.log(`${Colors.YELLOW}Example: scipen review main.tex${Colors.NC}`);
        process.exit(1);
      }
      await reviewCommand(args.slice(1));
      break;

    case 'formats':
      showFormats();
      break;

    case '--help':
    case '-h':
    case 'help':
      showHelp();
      break;

    case 'init':
      console.log(`${Colors.GREEN}✔ SDK version does not require initialization${Colors.NC}`);
      console.log(`${Colors.CYAN}  Use "scipen review <paper-file>" directly to start review${Colors.NC}`);
      console.log();
      console.log(`${Colors.YELLOW}  Environment Variable Configuration:${Colors.NC}`);
      console.log(`${Colors.YELLOW}  - MINERU_API_TOKEN: For PDF/DOC file conversion${Colors.NC}`);
      console.log(`${Colors.YELLOW}  - AMINER_API_KEY: For literature search functionality${Colors.NC}`);
      break;

    default:
      console.log(`${Colors.RED}Error: Unknown command "${command}"${Colors.NC}`);
      console.log();
      showHelp();
      process.exit(1);
  }
}

main();
