#!/usr/bin/env node

/**
 * @file index.ts - PDF2TeX CLI entry point
 * @description Main CLI entry point for PDF to LaTeX conversion tool using VLM
 * @depends path, fs, types, local-config-manager, logger, vlm-converter
 */

import * as path from 'path';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import type { ConversionOptions } from './types';
import { localConfigManager, getScipenHomeDir } from './utils/local-config-manager';
import { Logger } from './utils/logger';

const VERSION = '0.0.1';

// ====== JSON Protocol Types ======

interface VlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface CliSharedConfig {
  vlm?: VlmConfig;
  workingDirectory?: string;
  jsonOutput?: boolean;
}

interface Pdf2LatexParams {
  inputPath: string;
  outputPath?: string;
  dpi?: number;
  concurrent?: number;
}

interface CliInput {
  tool: string;
  version: string;
  params: Pdf2LatexParams;
  config: CliSharedConfig;
}

interface CliOutput<T = unknown> {
  success: boolean;
  message: string;
  data?: T;
  error?: { code: string; details?: string };
  version?: string;
}

// ====== JSON Output Utilities ======

let jsonMode = false;

function outputJson<T>(output: CliOutput<T>): void {
  output.version = VERSION;
  console.log(JSON.stringify(output));
}

function exitWithJson(success: boolean, message: string, data?: unknown, error?: { code: string; details?: string }): never {
  outputJson({ success, message, data, error });
  process.exit(success ? 0 : 1);
}

// ====== Help Information ======

function showHelp(): void {
  const scipenHome = getScipenHomeDir();
  console.log(`
\x1b[36m┌─────────────────────────────────────────────────────────────┐
│  SciPen PDF2TeX - CLI Tool for Converting PDF to LaTeX (VLM) │
└─────────────────────────────────────────────────────────────┘\x1b[0m

\x1b[33mUsage:\x1b[0m
  scipen-pdf2tex <command> [options]

\x1b[33mCommands:\x1b[0m
  convert <input.pdf>   Convert PDF to LaTeX
  init                  Check and initialize global configuration file

\x1b[33mJSON Configuration Mode (for SciPen Studio calls):\x1b[0m
  --config <path>       Read parameters from JSON configuration file
  --config-stdin        Read JSON configuration from stdin

\x1b[33mOptions (convert command):\x1b[0m
  -o, --output <path>      Output LaTeX file path
  --base-url <url>         VLM API endpoint URL
  --api-key <key>          API key
  --model <name>           Model name
  --dpi <number>          PDF rendering DPI (default: 300)
  --concurrent <number>    Concurrent request count (default: 3)
  --max-tokens <number>    Maximum token count
  --temperature <number>   Temperature parameter
  --timeout <number>       Request timeout (milliseconds)
  --max-retries <number>   Retry count on failure (default: 2)

\x1b[33mGeneral Options:\x1b[0m
  -h, --help               Show help information
  -v, --version            Show version number

\x1b[33mGlobal Working Directory:\x1b[0m
  All SciPen tools share ~/.scipen as global working directory:
  - ${scipenHome}/config.json      Global configuration file (VLM config)
  - ${scipenHome}/pdf2tex/        PDF conversion output directory

\x1b[33mConfiguration:\x1b[0m
  Configure under vlm field in ~/.scipen/config.json:
  - baseUrl: VLM API endpoint URL (required)
  - apiKey: API key (optional)
  - model: Model name (required, e.g., gpt-4-vision-preview)
  - maxTokens: Maximum token count
  - temperature: Temperature parameter
  - timeout: Request timeout (milliseconds)

\x1b[33mExamples:\x1b[0m
  # Initialize configuration
  scipen-pdf2tex init

  # Basic conversion (using global config)
  scipen-pdf2tex convert paper.pdf

  # Specify output path
  scipen-pdf2tex convert paper.pdf -o ./output/paper.tex

  # Use JSON configuration (for program calls)
  scipen-pdf2tex --config config.json

\x1b[33mEnvironment Variables:\x1b[0m
  VLM_API_KEY             VLM API key (optional, lower priority than config file)
`);
}

function showVersion(): void {
  console.log(`v${VERSION}`);
}

// ====== Argument Parsing ======

interface ParsedArgs {
  command?: string;
  input?: string;
  output?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  dpi: number;
  concurrent: number;
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
  maxRetries: number;
  showHelp: boolean;
  showVersion: boolean;
  configPath?: string;
  configStdin: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const config: ParsedArgs = {
    dpi: 300,
    concurrent: 3,
    maxRetries: 2,
    showHelp: false,
    showVersion: false,
    configStdin: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '-h':
      case '--help':
        config.showHelp = true;
        break;

      case '-v':
      case '--version':
        config.showVersion = true;
        break;

      case '-o':
      case '--output':
        config.output = args[++i];
        break;

      case '--base-url':
        config.baseUrl = args[++i];
        break;

      case '--api-key':
        config.apiKey = args[++i];
        break;

      case '--model':
        config.model = args[++i];
        break;

      case '--dpi':
        config.dpi = Number.parseInt(args[++i], 10) || 300;
        break;

      case '--concurrent':
        config.concurrent = Number.parseInt(args[++i], 10) || 3;
        break;

      case '--max-tokens':
        config.maxTokens = Number.parseInt(args[++i], 10);
        break;

      case '--temperature':
        config.temperature = Number.parseFloat(args[++i]);
        break;

      case '--timeout':
        config.timeout = Number.parseInt(args[++i], 10);
        break;

      case '--max-retries':
        config.maxRetries = Number.parseInt(args[++i], 10) || 2;
        break;

      case '--config':
        config.configPath = args[++i];
        break;

      case '--config-stdin':
        config.configStdin = true;
        break;

      case 'init':
      case 'convert':
        config.command = arg;
        break;

      default:
        if (!arg.startsWith('-') && !config.command) {
          config.command = arg;
        } else if (!arg.startsWith('-') && config.command === 'convert' && !config.input) {
          config.input = arg;
        }
    }
  }

  return config;
}

// ====== JSON Configuration Mode ======

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
    // Set timeout to avoid infinite waiting
    setTimeout(() => reject(new Error('stdin read timeout')), 5000);
  });
}

async function runWithJsonConfig(configPath?: string, fromStdin = false): Promise<void> {
  jsonMode = true;
  
  let configContent: string;
  
  try {
    if (fromStdin) {
      configContent = await readStdin();
    } else if (configPath) {
      configContent = await fsPromises.readFile(configPath, 'utf-8');
    } else {
      exitWithJson(false, 'No config provided', undefined, { code: 'NO_CONFIG' });
    }
    
    const input: CliInput = JSON.parse(configContent!);
    
    if (input.tool !== 'pdf2latex') {
      exitWithJson(false, `Invalid tool: expected pdf2latex, got ${input.tool}`, undefined, { code: 'INVALID_TOOL' });
    }
    
    const params = input.params;
    const config = input.config;
    
    if (!params.inputPath) {
      exitWithJson(false, 'Missing required parameter: inputPath', undefined, { code: 'MISSING_PARAM' });
    }
    
    try {
      await fsPromises.access(params.inputPath);
    } catch {
      exitWithJson(false, `Input file not found: ${params.inputPath}`, undefined, { code: 'FILE_NOT_FOUND' });
    }
    
    let outputPath: string;
    if (params.outputPath) {
      outputPath = params.outputPath;
    } else {
      const scipenHome = getScipenHomeDir();
      const paperName = path.basename(params.inputPath, '.pdf').replace(/[<>:"|?*]/g, '-');
      const pdf2texDir = path.join(scipenHome, 'pdf2tex', paperName);
      if (!fs.existsSync(pdf2texDir)) {
        fs.mkdirSync(pdf2texDir, { recursive: true });
      }
      outputPath = path.join(pdf2texDir, `${paperName}.tex`);
    }
    
    const vlmConfig = config.vlm;
    if (!vlmConfig?.baseUrl) {
      exitWithJson(false, 'Missing VLM config: baseUrl is required', undefined, { code: 'MISSING_VLM_CONFIG' });
    }
    if (!vlmConfig?.model) {
      exitWithJson(false, 'Missing VLM config: model is required', undefined, { code: 'MISSING_VLM_CONFIG' });
    }
    
    const options: ConversionOptions = {
      input: path.resolve(params.inputPath),
      output: path.resolve(outputPath),
      baseURL: vlmConfig!.baseUrl,
      apiKey: vlmConfig!.apiKey,
      model: vlmConfig!.model,
      dpi: params.dpi ?? 300,
      concurrent: params.concurrent ?? 3,
      maxRetries: 2,
    };
    
    const { VLMConverter } = await import('./converters/vlm-converter');
    const converter = new VLMConverter();
    await converter.convert(options);
    
    exitWithJson(true, 'Conversion completed successfully', {
      outputPath: options.output,
      pageCount: 0, // VLMConverter doesn't return page count yet, can be improved later
    });
    
  } catch (error: any) {
    if (error.message?.includes('JSON')) {
      exitWithJson(false, 'Invalid JSON config', undefined, { code: 'INVALID_JSON', details: error.message });
    }
    exitWithJson(false, error.message || 'Unknown error', undefined, { code: 'CONVERSION_ERROR', details: error.stack });
  }
}

// ====== Traditional Command Mode ======

async function initCommand(): Promise<void> {
  try {
    const scipenHome = getScipenHomeDir();
    const configPath = `${scipenHome}/config.json`;

    if (localConfigManager.exists()) {
      Logger.success('Configuration file exists and contains VLM config');
      Logger.info(`Config location: ${configPath}`);
      Logger.info('');
      Logger.info('Note: This config is shared with SciPen main application');
      return;
    }

    localConfigManager.ensureConfig();
    Logger.info('');
    Logger.info(`Configuration file location: ${configPath}`);
    Logger.info('');
    Logger.info('VLM configuration (under vlm field):');
    Logger.info('  baseUrl: VLM API endpoint URL (required)');
    Logger.info('  apiKey: API key (optional)');
    Logger.info('  model: Model name (required, e.g., gpt-4-vision-preview)');
    Logger.info('  maxTokens: Maximum token count (default: 8000)');
    Logger.info('  temperature: Temperature parameter (default: 0.3)');
    Logger.info('  timeout: Request timeout in milliseconds (default: 120000)');
    Logger.info('');
    Logger.info('Note: This config is shared with SciPen main application, changes apply to all tools');
    Logger.info('');
    Logger.info('Example usage:');
    Logger.info('  scipen-pdf2tex convert input.pdf');
    Logger.info('');
  } catch (error: any) {
    Logger.error(`Initialization failed: ${error.message}`);
    process.exit(1);
  }
}

async function convertCommand(config: ParsedArgs): Promise<void> {
  try {
    if (!config.input) {
      Logger.error('Error: convert command requires PDF input file');
      Logger.info('Usage: scipen-pdf2tex convert <input.pdf> [options]');
      process.exit(1);
    }

    localConfigManager.ensureConfig();
    const localConfig = localConfigManager.getVLMConfig();
    await fsPromises.access(config.input);

    let output: string;
    if (config.output) {
      output = config.output;
    } else {
      const scipenHome = getScipenHomeDir();
      const paperName = path.basename(config.input, '.pdf').replace(/[<>:"|?*]/g, '-');
      const pdf2texDir = path.join(scipenHome, 'pdf2tex', paperName);
      if (!fs.existsSync(pdf2texDir)) {
        fs.mkdirSync(pdf2texDir, { recursive: true });
      }
      output = path.join(pdf2texDir, `${paperName}.tex`);
    }

    const options: ConversionOptions = {
      input: path.resolve(config.input),
      output: path.resolve(output),
      baseURL: config.baseUrl || localConfig?.baseURL,
      apiKey: config.apiKey || localConfig?.apiKey,
      model: config.model || localConfig?.model,
      dpi: config.dpi || localConfig?.defaultDpi || 300,
      concurrent: config.concurrent || localConfig?.defaultConcurrent || 3,
      maxTokens: config.maxTokens || localConfig?.maxTokens,
      temperature: config.temperature || localConfig?.temperature,
      timeout: config.timeout || localConfig?.timeout,
      maxRetries: config.maxRetries || localConfig?.maxRetries || 2,
    };

    if (!options.baseURL) {
      throw new Error(
        'Missing required parameter: baseURL. Configure AI provider in SciPen Studio settings or specify via --base-url'
      );
    }
    if (!options.model) {
      throw new Error(
        'Missing required parameter: model. Configure AI provider in SciPen Studio settings or specify via --model'
      );
    }

    if (localConfigManager.exists()) {
      Logger.info('✓ Using global config: ~/.scipen/config.json');
    }
    Logger.info(`Input file: ${options.input}`);
    Logger.info(`Output file: ${options.output}`);
    Logger.info(`API endpoint: ${options.baseURL}`);
    Logger.info(`Model: ${options.model}`);
    Logger.info(`DPI: ${options.dpi}`);
    Logger.info(`Concurrent: ${options.concurrent}`);

    const { VLMConverter } = await import('./converters/vlm-converter');
    const converter = new VLMConverter();
    await converter.convert(options);

    Logger.success('Conversion completed!');
  } catch (error: any) {
    Logger.error(`Conversion failed: ${error.message}`);
    process.exit(1);
  }
}

// ====== Main Entry Point ======

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const config = parseArgs(args);

  // JSON config mode takes priority
  if (config.configPath || config.configStdin) {
    await runWithJsonConfig(config.configPath, config.configStdin);
    return;
  }

  if (config.showHelp) {
    showHelp();
    process.exit(0);
  }

  if (config.showVersion) {
    showVersion();
    process.exit(0);
  }

  if (!config.command) {
    console.error('\x1b[31mError: Missing command\x1b[0m\n');
    showHelp();
    process.exit(1);
  }

  switch (config.command) {
    case 'init':
      await initCommand();
      break;

    case 'convert':
      await convertCommand(config);
      break;

    default:
      console.error(`\x1b[31mError: Unknown command "${config.command}"\x1b[0m\n`);
      showHelp();
      process.exit(1);
  }
}

// Global exception handling
process.on('uncaughtException', (error) => {
  if (jsonMode) {
    outputJson({
      success: false,
      message: 'Uncaught exception',
      error: { code: 'UNCAUGHT_EXCEPTION', details: error.message },
    });
  } else {
    console.error(`\x1b[31mUncaught exception: ${error.message}\x1b[0m`);
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (jsonMode) {
    outputJson({
      success: false,
      message: 'Unhandled rejection',
      error: { code: 'UNHANDLED_REJECTION', details: message },
    });
  } else {
    console.error(`\x1b[31mUnhandled rejection: ${message}\x1b[0m`);
  }
  process.exit(1);
});

main();
