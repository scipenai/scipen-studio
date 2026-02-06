/**
 * @file init.ts - Initialize command for PDF2TeX CLI
 * @description Checks and initializes global configuration file ~/.scipen/config.json
 * @depends commander, local-config-manager, logger
 */

import { Command } from 'commander';
import { localConfigManager, getScipenHomeDir } from '../utils/local-config-manager';
import { Logger } from '../utils/logger';

export function createInitCommand() {
  const command = new Command('init');

  command.description('Check and initialize global configuration file ~/.scipen/config.json').action(async () => {
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
      Logger.info('  apiKey: API key (required)');
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
  });

  return command;
}
