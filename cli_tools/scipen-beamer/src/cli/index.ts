#!/usr/bin/env node

/**
 * @file index.ts - SciPen Beamer CLI
 * @description Academic paper to Beamer presentation converter
 * @depends path, fs, mainController, interactive, statusDisplay, templateManager
 */

import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { MainController, getScipenHomeDir } from '../core/mainController.js';
import { InteractiveCLI } from './interactive.js';
import { StatusDisplay } from '../utils/statusDisplay.js';
import { TemplateManager } from '../utils/templateManager.js';

const Colors = StatusDisplay.Colors;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function showHelp(): void {
  console.log(`${Colors.CYAN}SciPen Beamer - Academic Paper to Beamer Presentation (SDK Version)${Colors.NC}`);
  console.log();
  console.log(`${Colors.YELLOW}Usage:${Colors.NC}`);
  console.log('  scipen-beamer convert <paper-file> [options]    Convert paper to Beamer presentation');
  console.log('  scipen-beamer --help                            Show help information');
  console.log();
  console.log(`${Colors.YELLOW}Options:${Colors.NC}`);
  console.log('  -o, --output <dir>       Output directory (default: ~/.scipen/beamer)');
  console.log('  --output-file <path>     Directly specify output .tex file path (takes precedence over --output)');
  console.log('  -d, --duration <min>     Presentation duration (minutes, default: 15)');
  console.log('  -t, --template <path>    Use custom Beamer template');
  console.log('  --no-interactive         Skip interaction, use default style directly');
  console.log('  --skip-compilation       Skip automatic compilation');
  console.log();
  console.log(`${Colors.YELLOW}Environment Variables:${Colors.NC}`);
  console.log('  ANTHROPIC_API_KEY       Claude API key (required)');
  console.log();
  console.log(`${Colors.YELLOW}Examples:${Colors.NC}`);
  console.log('  scipen-beamer convert paper.tex');
  console.log('  scipen-beamer convert paper.tex -d 20');
  console.log('  scipen-beamer convert paper.tex --no-interactive');
  console.log('  scipen-beamer convert paper.tex -t my-template.tex');
  console.log();
  console.log(`${Colors.YELLOW}Output Directory:${Colors.NC}`);
  console.log('  ~/.scipen/beamer/<paper-name>/');
  console.log('    ├── presentation.tex    Generated presentation');
  console.log('    ├── presentation.pdf    Compiled PDF (if compilation enabled)');
  console.log('    ├── log/                Execution logs');
  console.log('    └── json/               Structured data');
}

function showVersion(): void {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf-8')
    );
    console.log(`v${packageJson.version}`);
  } catch {
    console.log('v2.0.0');
  }
}

interface ConvertOptions {
  paperPath: string;
  outputDir: string;
  outputFile?: string;
  duration: number;
  interactive: boolean;
  templatePath?: string;
  skipCompilation: boolean;
}

function parseArgs(args: string[]): {
  command?: string;
  options: Partial<ConvertOptions>;
  showHelp: boolean;
  showVersion: boolean;
} {
  const defaultOutputDir = path.join(getScipenHomeDir(), 'beamer');

  const result = {
    command: undefined as string | undefined,
    options: {
      paperPath: undefined as string | undefined,
      outputDir: defaultOutputDir,
      outputFile: undefined as string | undefined,
      duration: 15,
      interactive: true,
      templatePath: undefined as string | undefined,
      skipCompilation: false,
    },
    showHelp: false,
    showVersion: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '-h':
      case '--help':
      case 'help':
        result.showHelp = true;
        break;

      case '-v':
      case '--version':
        result.showVersion = true;
        break;

      case '-o':
      case '--output':
        result.options.outputDir = args[++i];
        break;
      case '--output-file':
        result.options.outputFile = args[++i];
        break;

      case '-d':
      case '--duration':
        const val = parseInt(args[++i], 10);
        if (isNaN(val) || val < 1 || val > 120) {
          console.log(`${Colors.RED}Error: Presentation duration must be a positive integer between 1-120${Colors.NC}`);
          process.exit(1);
        }
        result.options.duration = val;
        break;

      case '-t':
      case '--template':
        result.options.templatePath = args[++i];
        break;

      case '--no-interactive':
        result.options.interactive = false;
        break;

      case '--skip-compilation':
        result.options.skipCompilation = true;
        break;

      case 'convert':
        result.command = 'convert';
        break;

      default:
        if (!arg.startsWith('-')) {
          if (!result.command) {
            result.command = 'convert';
            result.options.paperPath = arg;
          } else if (result.command === 'convert' && !result.options.paperPath) {
            result.options.paperPath = arg;
          }
        }
    }
  }

  return result;
}

async function convertCommand(options: Partial<ConvertOptions>): Promise<void> {
  if (!options.paperPath) {
    console.log(`${Colors.RED}Error: convert command requires a paper file${Colors.NC}`);
    console.log(`${Colors.YELLOW}Usage: scipen-beamer convert <paper-file> [options]${Colors.NC}`);
    console.log(`${Colors.YELLOW}Example: scipen-beamer convert paper.tex${Colors.NC}`);
    process.exit(1);
  }

  if (!fs.existsSync(options.paperPath)) {
    console.log(`${Colors.RED}Error: File not found: ${options.paperPath}${Colors.NC}`);
    process.exit(1);
  }

  // Handle output file path (takes precedence over outputDir)
  if (options.outputFile) {
    const resolvedOutputFile = path.resolve(options.outputFile);
    const ext = path.extname(resolvedOutputFile);
    if (ext && ext.toLowerCase() !== '.tex') {
      console.log(`${Colors.RED}Error: Output file must be .tex: ${resolvedOutputFile}${Colors.NC}`);
      process.exit(1);
    }
    const finalOutputFile = ext ? resolvedOutputFile : `${resolvedOutputFile}.tex`;
    options.outputFile = finalOutputFile;
    options.outputDir = path.dirname(finalOutputFile);
  }

  console.log();
  console.log(`${Colors.CYAN}Configuration:${Colors.NC}`);

  if (options.templatePath) {
    if (fs.existsSync(options.templatePath)) {
      console.log(`  ${Colors.GREEN}✔${Colors.NC} Custom template: ${path.basename(options.templatePath)}`);

      const templateManager = new TemplateManager(options.outputDir);
      const validation = templateManager.validateTemplate(options.templatePath);

      if (!validation.valid) {
        console.log(`  ${Colors.YELLOW}⚠${Colors.NC} Template warnings:`);
        validation.errors.forEach(err => console.log(`    - ${err}`));
      }

      const templateContent = fs.readFileSync(options.templatePath, 'utf-8');
      const packageInfo = templateManager.extractRequiredPackages(templateContent);

      if (packageInfo.found.length > 0) {
        console.log(`  ${Colors.GREEN}✔${Colors.NC} Found custom styles: ${packageInfo.found.join(', ')}`);
      }

      if (packageInfo.missing.length > 0) {
        const dirs = templateManager.getDirectoryPaths();
        console.log(`  ${Colors.YELLOW}⚠${Colors.NC} Potentially required style files (not found in styles/ directory):`);
        packageInfo.missing.forEach(name => console.log(`    - ${name}.sty`));
        console.log(`    ${Colors.CYAN}Hint: If these are custom styles, please place them in ${dirs.styles}${Colors.NC}`);
        console.log(`    ${Colors.CYAN}      If these are standard TeX packages, you can ignore this warning${Colors.NC}`);
      }
    } else {
      console.log(`${Colors.RED}Error: Template file not found: ${options.templatePath}${Colors.NC}`);
      process.exit(1);
    }
  } else {
    console.log(`  ${Colors.YELLOW}○${Colors.NC} Using default style (Boadilla theme)`);
  }

  if (options.skipCompilation) {
    console.log(`  ${Colors.YELLOW}○${Colors.NC} Automatic compilation skipped`);
  }

  console.log();

  try {
    const controller = new MainController();

    let useCustomTemplate = false;
    let customTemplatePath: string | undefined = undefined;

    if (options.templatePath) {
      useCustomTemplate = true;
      customTemplatePath = options.templatePath;
    } else if (options.interactive) {
      const cli = new InteractiveCLI(options.outputDir!);
      const templateChoice = await cli.askForTemplate();
      useCustomTemplate = templateChoice.useCustomTemplate;
      customTemplatePath = templateChoice.templatePath;
    }

    const result = await controller.generate(options.paperPath, {
      outputDir: options.outputDir,
      outputFile: options.outputFile,
      duration: options.duration,
      useCustomTemplate,
      customTemplatePath,
      skipCompilation: options.skipCompilation,
    });

    if (result.success) {
      console.log(`${Colors.GREEN}✔ Generation complete${Colors.NC}`);
      console.log(`${Colors.CYAN}  TeX file: ${result.texPath}${Colors.NC}`);
      if (result.pdfPath) {
        console.log(`${Colors.GREEN}  PDF file: ${result.pdfPath}${Colors.NC}`);
      } else {
        console.log(`${Colors.YELLOW}  Compilation command: cd "${result.outputDir}" && xelatex ${path.basename(result.texPath)}${Colors.NC}`);
      }
    } else {
      console.log(`${Colors.YELLOW}⚠ Generation complete, but there may be issues${Colors.NC}`);
    }
  } catch (error: any) {
    console.error(`${Colors.RED}Generation failed:${Colors.NC}`, error.message);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    showHelp();
    process.exit(1);
  }

  const parsed = parseArgs(args);

  if (parsed.showHelp) {
    showHelp();
    process.exit(0);
  }

  if (parsed.showVersion) {
    showVersion();
    process.exit(0);
  }

  const command = parsed.command;

  switch (command) {
    case 'convert':
      await convertCommand(parsed.options);
      break;

    default:
      console.log(`${Colors.RED}Error: Unknown command "${command}"${Colors.NC}`);
      console.log();
      showHelp();
      process.exit(1);
  }
}

main();
