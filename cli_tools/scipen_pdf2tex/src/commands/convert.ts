/**
 * @file convert.ts - Convert command for PDF2TeX CLI
 * @description Converts PDF files to LaTeX using VLM (Vision Language Model)
 * @depends commander, types, local-config-manager, logger, path, fs
 */

import { Command } from 'commander';
import type { ConversionOptions } from '../types';
import { localConfigManager, getScipenHomeDir } from '../utils/local-config-manager';
import { Logger } from '../utils/logger';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';

export function createConvertCommand() {
  const command = new Command('convert');

  command
    .description('Convert PDF to LaTeX')
    .argument('<input>', 'PDF input file path')
    .option(
      '-o, --output <path>',
      'Output LaTeX file path (default: ~/.scipen/pdf2tex/<paper-name>/<paper-name>.tex)'
    )
    .option('--base-url <url>', 'VLM API endpoint URL')
    .option('--api-key <key>', 'API key')
    .option('--model <name>', 'Model name')
    .option('--dpi <number>', 'PDF rendering DPI', '300')
    .option('--concurrent <number>', 'Concurrent request count', '3')
    .option('--max-tokens <number>', 'Maximum token count')
    .option('--temperature <number>', 'Temperature parameter')
    .option('--timeout <number>', 'Request timeout in milliseconds')
    .option('--max-retries <number>', 'Retry count on failure', '2')
    .action(async (input: string, cmdOptions: any) => {
      try {
        localConfigManager.ensureConfig();
        const localConfig = localConfigManager.getVLMConfig();
        await fs.access(input);

        let output: string;
        if (cmdOptions.output) {
          output = cmdOptions.output;
        } else {
          const scipenHome = getScipenHomeDir();
          // Create subdirectory based on paper name
          const paperName = path.basename(input, '.pdf').replace(/[<>:"|?*]/g, '-');
          const pdf2texDir = path.join(scipenHome, 'pdf2tex', paperName);
          if (!fsSync.existsSync(pdf2texDir)) {
            fsSync.mkdirSync(pdf2texDir, { recursive: true });
          }
          output = path.join(pdf2texDir, `${paperName}.tex`);
        }
        const options: ConversionOptions = {
          input: path.resolve(input),
          output: path.resolve(output),
          baseURL: cmdOptions.baseUrl || localConfig?.baseURL,
          apiKey: cmdOptions.apiKey || localConfig?.apiKey,
          model: cmdOptions.model || localConfig?.model,
          dpi: Number.parseInt(cmdOptions.dpi) || localConfig?.defaultDpi || 300,
          concurrent: Number.parseInt(cmdOptions.concurrent) || localConfig?.defaultConcurrent || 3,
          maxTokens: cmdOptions.maxTokens ? Number.parseInt(cmdOptions.maxTokens) : localConfig?.maxTokens,
          temperature: cmdOptions.temperature
            ? Number.parseFloat(cmdOptions.temperature)
            : localConfig?.temperature,
          timeout: cmdOptions.timeout ? Number.parseInt(cmdOptions.timeout) : localConfig?.timeout,
          maxRetries: cmdOptions.maxRetries
            ? Number.parseInt(cmdOptions.maxRetries)
            : localConfig?.maxRetries || 2,
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

        // Only show message when using local config and command-line args are missing
        const usedLocalConfig = !cmdOptions.baseUrl && localConfig?.baseURL;
        if (usedLocalConfig && localConfigManager.exists()) {
          Logger.info('✓ Using local config: ~/.scipen/config.json (command-line args not specified)');
        }
        Logger.info(`Input file: ${options.input}`);
        Logger.info(`Output file: ${options.output}`);
        Logger.info(`API endpoint: ${options.baseURL}`);
        Logger.info(`Model: ${options.model}`);
        Logger.info(`DPI: ${options.dpi}`);
        Logger.info(`Concurrent: ${options.concurrent}`);
        const { VLMConverter } = await import('../converters/vlm-converter');
        const converter = new VLMConverter();
        await converter.convert(options);

        Logger.success('Conversion completed!');
      } catch (error: any) {
        Logger.error(`Conversion failed: ${error.message}`);
        process.exit(1);
      }
    });

  return command;
}
