/**
 * @file AgentService - CLI Agent Execution Service
 * @description Manages secure execution of external CLI tools with command whitelist and process monitoring
 * @depends child_process, electron, fsCompat, LoggerService
 */

import { type ChildProcess, spawn } from 'child_process';
import * as fsSync from 'fs';
import os from 'os';
import path from 'path';
import { app } from 'electron';
import { createLogger } from './LoggerService';
import fs from './knowledge/utils/fsCompat';

const logger = createLogger('AgentService');
import type {
  AgentExecutionOptions,
  AgentResult,
  IAgentService,
  IConfigManager,
  Paper2BeamerConfig,
  Pdf2LatexConfig,
} from './interfaces';

// Re-export types for backward compatibility
export type { AgentResult, AgentExecutionOptions, AgentResultData } from './interfaces';

/**
 * CLI tool configuration: directory name and entry file
 */
const EMBEDDED_TOOL_CONFIG: Record<string, { dir: string; entry: string }> = {
  'scipen-pdf2tex': { dir: 'scipen-pdf2tex', entry: 'index.js' },
  'scipen-review': { dir: 'scipen-reviewer', entry: 'cli/scipen-cli.mjs' }, // ESM format
  'scipen-beamer': { dir: 'scipen-beamer', entry: 'cli/index.mjs' }, // ESM format
};

/**
 * @file AgentService - SciPen CLI tool invocation service
 * @description Invokes embedded CLI tools (pdf2tex, reviewer, beamer) with fallback to global commands.
 * @depends IConfigManager, fsCompat
 * @implements IAgentService
 */
export class AgentService implements IAgentService {
  private currentProcess: ChildProcess | null = null;

  constructor(private readonly configManager: IConfigManager) {}

  /**
   * Gets the embedded CLI tool entry file path.
   * @returns Entry file path, or null if not found
   */
  private getEmbeddedToolPath(toolName: string): string | null {
    const toolConfig = EMBEDDED_TOOL_CONFIG[toolName];
    if (!toolConfig) return null;

    // Production: resources/cli/<tool>/<entry>
    // Development: cli_tools/<tool>/dist/<entry>
    let basePath: string;
    if (app.isPackaged) {
      basePath = path.join(process.resourcesPath, 'cli', toolConfig.dir);
    } else {
      // Dev mode: look in project root cli_tools directory
      // Note: scipen_pdf2tex uses underscore, others use hyphen
      const devToolName = toolConfig.dir === 'scipen-pdf2tex' ? 'scipen_pdf2tex' : toolConfig.dir;
      basePath = path.join(app.getAppPath(), 'cli_tools', devToolName, 'dist');
    }

    const entryPath = path.join(basePath, toolConfig.entry);

    if (fsSync.existsSync(entryPath)) {
      return entryPath;
    }

    return null;
  }

  /**
   * Gets NODE_PATH for shared dependencies.
   * Allows embedded scripts to resolve main app's node_modules and CLI tool's node_modules.
   * @param scriptPath CLI script path, used to locate CLI tool's node_modules
   */
  private getNodePath(scriptPath?: string): string {
    const paths: string[] = [];

    // 1. If script path provided, add CLI tool's node_modules (for @anthropic-ai/claude-agent-sdk)
    if (scriptPath) {
      // Script path like: .../cli/scipen-reviewer/cli/scipen-cli.js
      // CLI tool's node_modules at: .../cli/scipen-reviewer/node_modules
      const scriptDir = path.dirname(scriptPath);
      const cliToolDir = path.dirname(scriptDir); // Parent directory
      const cliNodeModules = path.join(cliToolDir, 'node_modules');
      if (fsSync.existsSync(cliNodeModules)) {
        paths.push(cliNodeModules);
      }
    }

    // 2. Main app's node_modules
    if (app.isPackaged) {
      // Production: node_modules inside asar and in asar.unpacked
      paths.push(path.join(process.resourcesPath, 'app.asar', 'node_modules'));
      paths.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules'));
    } else {
      // Development: node_modules in project root
      paths.push(path.join(app.getAppPath(), 'node_modules'));
    }

    return paths.join(path.delimiter);
  }

  /**
   * Executes embedded script.
   * Runs embedded JS files via Node.js subprocess, sharing dependencies through NODE_PATH.
   */
  private executeEmbedded(
    scriptPath: string,
    args: string[],
    options?: AgentExecutionOptions,
    extraEnv?: Record<string, string>
  ): Promise<AgentResult> {
    return new Promise((resolve) => {
      const timeout = options?.timeout || 1800000; // Default 30 minutes

      options?.onProgress?.('Executing embedded tool...', 0);

      // Use process.execPath (Electron's bundled Node.js) to run script
      const nodePath = this.getNodePath(scriptPath);
      const child = spawn(process.execPath, [scriptPath, ...args], {
        cwd: options?.workingDirectory || process.cwd(),
        env: {
          ...process.env,
          NODE_PATH: nodePath,
          SCIPEN_NODE_MODULES: nodePath,
          ELECTRON_RUN_AS_NODE: '1', // Run Electron as Node.js
          LANG: 'en_US.UTF-8',
          LC_ALL: 'en_US.UTF-8',
          ...extraEnv, // Extra env vars (e.g., ANTHROPIC_API_KEY)
        },
        windowsHide: true,
      });

      this.currentProcess = child;

      let stdout = '';
      let stderr = '';
      let lastProgress = 0;

      const timeoutId = setTimeout(() => {
        if (child && !child.killed) {
          this.killCurrentProcess();
          resolve({
            success: false,
            message: `Command execution timeout (${timeout / 1000}s)`,
          });
        }
      }, timeout);

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');

      child.stdout?.on('data', (data) => {
        const output = this.cleanAnsiCodes(data.toString());
        stdout += output;

        const progressMatch = output.match(/(\d+)%/);
        if (progressMatch) {
          lastProgress = Number.parseInt(progressMatch[1]);
        }

        options?.onProgress?.(output.trim(), lastProgress);
      });

      child.stderr?.on('data', (data) => {
        stderr += this.cleanAnsiCodes(data.toString());
      });

      child.on('close', (code) => {
        clearTimeout(timeoutId);
        this.currentProcess = null;

        if (code === 0) {
          resolve({
            success: true,
            message: 'Execution succeeded',
            data: { stdout, stderr },
            progress: 100,
          });
        } else {
          resolve({
            success: false,
            message: `Execution failed (Exit Code: ${code}): ${stderr || stdout}`,
            data: { stdout, stderr },
          });
        }
      });

      child.on('error', (err) => {
        clearTimeout(timeoutId);
        this.currentProcess = null;

        resolve({
          success: false,
          message: `Embedded tool execution failed: ${err.message}`,
        });
      });
    });
  }

  /**
   * Gets Anthropic env vars from main app's AI configuration.
   * Used for passing to Claude Code powered tools (reviewer / paper2beamer).
   */
  private getAnthropicEnvFromApp(): { apiKey?: string; baseUrl?: string } {
    try {
      const aiConfig = this.configManager.getFullAIConfig();
      const providers = aiConfig.providers || [];

      // Find Anthropic provider
      const anthropicProvider = providers.find(
        (p) => p.id === 'anthropic' && p.enabled && p.apiKey
      );
      if (anthropicProvider?.apiKey) {
        return {
          apiKey: anthropicProvider.apiKey,
          baseUrl: anthropicProvider.apiHost || anthropicProvider.defaultApiHost,
        };
      }

      // If no dedicated anthropic provider, return empty config
      return {};
    } catch (error) {
      logger.error('[AgentService] Failed to get Anthropic env vars:', error);
      return {};
    }
  }

  /**
   * Gets VLM configuration from main app's AI configuration.
   * Used for passing to CLI tools.
   */
  private getVLMConfigFromApp(): { baseUrl?: string; apiKey?: string; model?: string } {
    try {
      const aiConfig = this.configManager.getFullAIConfig();
      const providers = aiConfig.providers || [];
      const selectedVision = aiConfig.selectedModels?.vision || null;

      type Provider = (typeof providers)[number];
      type ProviderModel = Provider['models'][number];

      let provider: Provider | undefined;
      let model: ProviderModel | undefined;

      // Prefer user-selected vision model
      if (selectedVision) {
        provider = providers.find((p) => p.id === selectedVision.providerId);
        if (provider?.apiKey) {
          model = provider.models.find((m) => m.id === selectedVision.modelId);
        }
      }

      // If not selected or invalid, use enabled vision provider
      if (!provider || !model) {
        const visionProviders = ['openai', 'anthropic', 'deepseek', 'siliconflow', 'aihubmix'];
        provider = providers.find((p) => p.enabled && visionProviders.includes(p.id) && p.apiKey);
      }

      // If not found, use any enabled provider
      if (!provider || !provider.apiKey) {
        provider = providers.find((p) => p.enabled && p.apiKey);
      }

      if (!provider) {
        logger.warn('[AgentService] No available AI provider configuration found');
        return {};
      }

      // If model not specified, find vision model (image-capable model)
      if (!model) {
        const visionKeywords = ['vision', 'gpt-4o', 'claude-3', 'gemini', '4v'];
        model = provider.models.find(
          (m) =>
            m.type === 'vision' ||
            m.capabilities?.vision ||
            visionKeywords.some((k) => m.id.toLowerCase().includes(k))
        );
      }

      // If no vision model found, use first model
      if (!model && provider.models.length > 0) {
        model = provider.models[0];
      }

      const baseUrl = provider.apiHost || provider.defaultApiHost;

      return {
        baseUrl: baseUrl,
        apiKey: provider.apiKey,
        model: model?.id,
      };
    } catch (error) {
      logger.error('[AgentService] Failed to get VLM configuration:', error);
      return {};
    }
  }

  /**
   * PDF to LaTeX conversion.
   * Prefers embedded tool, falls back to global command on failure.
   * Automatically gets VLM params from main app's AI configuration.
   */
  async pdf2latex(
    inputFile: string,
    config?: Pdf2LatexConfig,
    options?: AgentExecutionOptions
  ): Promise<AgentResult> {
    const args = ['convert', inputFile];

    // Get VLM config from main app (if user hasn't manually specified)
    const appVlmConfig = this.getVLMConfigFromApp();

    // Build CLI args (user config > app config)
    const baseUrl = config?.baseUrl || appVlmConfig.baseUrl;
    const apiKey = config?.apiKey || appVlmConfig.apiKey;
    const model = config?.model || appVlmConfig.model;

    if (baseUrl) {
      args.push('--base-url', baseUrl);
    }
    if (apiKey) {
      args.push('--api-key', apiKey);
    }
    if (model) {
      args.push('--model', model);
    }
    if (config?.outputFile) {
      args.push('--output', config.outputFile);
    }
    if (config?.concurrent) {
      args.push('--concurrent', config.concurrent.toString());
    }

    // Try embedded mode first
    const embeddedPath = this.getEmbeddedToolPath('scipen-pdf2tex');
    if (embeddedPath) {
      const result = await this.executeEmbedded(embeddedPath, args, options);
      if (result.success) return result;
      logger.warn('[AgentService] Embedded tool execution failed, trying global command', {
        message: result.message,
        stderr: result.data?.stderr,
      });
    }

    // Fallback to global command
    return this.executeCommand('scipen-pdf2tex', args, options);
  }

  /**
   * Paper review.
   * Prefers embedded tool, falls back to global command on failure.
   * Automatically gets Anthropic API Key from main app config.
   */
  async reviewPaper(inputFile: string, options?: AgentExecutionOptions): Promise<AgentResult> {
    const args = ['review', inputFile];

    // Get Anthropic env vars for Claude Code
    const anthropicEnv = this.getAnthropicEnvFromApp();
    const extraEnv: Record<string, string> = {};
    if (anthropicEnv.baseUrl && !process.env.ANTHROPIC_BASE_URL) {
      extraEnv.ANTHROPIC_BASE_URL = anthropicEnv.baseUrl;
    }
    if (anthropicEnv.apiKey) {
      const useAuthToken =
        !!anthropicEnv.baseUrl && !anthropicEnv.baseUrl.includes('anthropic.com');
      if (useAuthToken && !process.env.ANTHROPIC_AUTH_TOKEN) {
        extraEnv.ANTHROPIC_AUTH_TOKEN = anthropicEnv.apiKey;
      }
      if (!useAuthToken && !process.env.ANTHROPIC_API_KEY) {
        extraEnv.ANTHROPIC_API_KEY = anthropicEnv.apiKey;
      }
    }

    const embeddedPath = this.getEmbeddedToolPath('scipen-review');
    if (embeddedPath) {
      const result = await this.executeEmbedded(embeddedPath, args, options, extraEnv);
      if (result.success) return result;
      logger.warn('[AgentService] Embedded tool execution failed, trying global command', {
        message: result.message,
        stderr: result.data?.stderr,
      });
    }

    return this.executeCommand('scipen-review', args, options);
  }

  /**
   * Paper to Beamer slides conversion.
   * Prefers embedded tool, falls back to global command on failure.
   * Automatically gets Anthropic API Key from main app config.
   */
  async paper2beamer(
    inputFile: string,
    config?: Paper2BeamerConfig,
    options?: AgentExecutionOptions
  ): Promise<AgentResult> {
    const args = ['convert', inputFile, '--no-interactive'];

    if (config?.output) {
      args.push('-o', config.output);
    }

    if (config?.duration) {
      args.push('-d', config.duration.toString());
    }

    if (config?.template) {
      args.push('-t', config.template);
    }

    // Get Anthropic env vars for Claude Code
    const anthropicEnv = this.getAnthropicEnvFromApp();
    const extraEnv: Record<string, string> = {};
    if (anthropicEnv.baseUrl && !process.env.ANTHROPIC_BASE_URL) {
      extraEnv.ANTHROPIC_BASE_URL = anthropicEnv.baseUrl;
    }
    if (anthropicEnv.apiKey) {
      const useAuthToken =
        !!anthropicEnv.baseUrl && !anthropicEnv.baseUrl.includes('anthropic.com');
      if (useAuthToken && !process.env.ANTHROPIC_AUTH_TOKEN) {
        extraEnv.ANTHROPIC_AUTH_TOKEN = anthropicEnv.apiKey;
      }
      if (!useAuthToken && !process.env.ANTHROPIC_API_KEY) {
        extraEnv.ANTHROPIC_API_KEY = anthropicEnv.apiKey;
      }
    }

    const embeddedPath = this.getEmbeddedToolPath('scipen-beamer');
    if (embeddedPath) {
      const result = await this.executeEmbedded(embeddedPath, args, options, extraEnv);
      if (result.success) return result;
      logger.warn('[AgentService] Embedded tool execution failed, trying global command', {
        message: result.message,
        stderr: result.data?.stderr,
      });
    }

    return this.executeCommand('scipen-beamer', args, options);
  }

  /**
   * Lists available Beamer templates.
   */
  async listBeamerTemplates(): Promise<AgentResult> {
    const beamerDir = path.join(os.homedir(), '.scipen', 'beamer');
    const templatesDir = path.join(beamerDir, 'templates');
    const stylesDir = path.join(beamerDir, 'styles');

    try {
      const templates: string[] = [];
      const styles: string[] = [];

      if (await fs.pathExists(templatesDir)) {
        const files = await fs.readdir(templatesDir);
        templates.push(...files.filter((f: string) => f.endsWith('.tex')));
      }

      if (await fs.pathExists(stylesDir)) {
        const files = await fs.readdir(stylesDir);
        styles.push(...files.filter((f: string) => f.endsWith('.sty')));
      }

      return {
        success: true,
        message: 'Template list retrieved successfully',
        data: {
          templates,
          styles,
          templatesDir,
          stylesDir,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to get template list: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Allowed CLI commands whitelist.
   * @security Only allows execution of predefined commands
   */
  private static readonly ALLOWED_COMMANDS = new Set([
    'scipen-pdf2tex',
    'scipen-review',
    'scipen-beamer',
  ]);

  /**
   * Validates if command is in whitelist.
   * @security Prevents command injection attacks
   */
  private isAllowedCommand(command: string): boolean {
    return AgentService.ALLOWED_COMMANDS.has(command);
  }

  /**
   * Validates and sanitizes file path.
   * @security Prevents path traversal and command injection
   */
  private sanitizeFilePath(filePath: string): string {
    // Check for path traversal attacks
    if (filePath.includes('..') || filePath.includes('\0')) {
      throw new Error('Invalid file path: path traversal detected');
    }

    // Check shell metacharacters (note: Windows paths use backslash, not dangerous)
    // Dangerous chars: ; & | ` $ ( ) { } [ ] < > ! # * ? ' "
    const dangerousChars = /[;&|`$(){}[\]<>!#*?'"]/;
    if (dangerousChars.test(filePath)) {
      throw new Error('Invalid file path: contains shell metacharacters');
    }

    // Normalize path
    return path.resolve(filePath);
  }

  /**
   * Checks if global command is available.
   * Verifies by running command --version.
   */
  async isCommandAvailable(command: string): Promise<boolean> {
    // @security Only check whitelisted commands
    if (!this.isAllowedCommand(command)) {
      console.warn(`[AgentService] Command not in whitelist: ${command}`);
      return false;
    }

    return new Promise((resolve) => {
      // @security Use shell: false to prevent command injection
      // Windows needs special handling (npm global commands need .cmd suffix)
      // But spawn EINVAL error usually indicates need shell: true for proper env resolution
      const isWindows = process.platform === 'win32';

      // On Windows use shell: true for probing
      const useShell = isWindows;
      const actualCommand = command;

      try {
        const child = spawn(actualCommand, ['--version'], {
          shell: useShell,
          windowsHide: true,
          timeout: 5000,
        });

        child.on('close', (code) => {
          resolve(code === 0);
        });

        child.on('error', () => {
          resolve(false);
        });
      } catch (error) {
        console.warn(`[AgentService] Spawn error for ${command}:`, error);
        resolve(false);
      }
    });
  }

  /**
   * Checks CLI tool availability (embedded first, global fallback).
   * Implements IAgentService interface.
   */
  async checkAvailability(): Promise<{
    pdf2latex: boolean;
    reviewer: boolean;
    paper2beamer: boolean;
  }> {
    // Check embedded tools
    const pdf2latexEmbedded = this.getEmbeddedToolPath('scipen-pdf2tex') !== null;
    const reviewerEmbedded = this.getEmbeddedToolPath('scipen-review') !== null;
    const paper2beamerEmbedded = this.getEmbeddedToolPath('scipen-beamer') !== null;

    // If embedded unavailable, check global commands
    const [pdf2latexGlobal, reviewerGlobal, paper2beamerGlobal] = await Promise.all([
      pdf2latexEmbedded ? Promise.resolve(false) : this.isCommandAvailable('scipen-pdf2tex'),
      reviewerEmbedded ? Promise.resolve(false) : this.isCommandAvailable('scipen-review'),
      paper2beamerEmbedded ? Promise.resolve(false) : this.isCommandAvailable('scipen-beamer'),
    ]);

    return {
      pdf2latex: pdf2latexEmbedded || pdf2latexGlobal,
      reviewer: reviewerEmbedded || reviewerGlobal,
      paper2beamer: paper2beamerEmbedded || paper2beamerGlobal,
    };
  }

  /**
   * Terminates the currently running process.
   */
  killCurrentProcess(): boolean {
    if (this.currentProcess && !this.currentProcess.killed) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(this.currentProcess.pid), '/f', '/t'], { shell: true });
      } else {
        this.currentProcess.kill('SIGTERM');
      }
      this.currentProcess = null;
      return true;
    }
    return false;
  }

  /**
   * Executes CLI tool (global command).
   * @security Security-enhanced version
   */
  private async executeCommand(
    command: string,
    args: string[],
    options?: AgentExecutionOptions
  ): Promise<AgentResult> {
    // @security Verify command is in whitelist
    if (!this.isAllowedCommand(command)) {
      return {
        success: false,
        message: `Security error: Command "${command}" is not allowed`,
      };
    }

    // @security Validate and sanitize all file paths in arguments
    const sanitizedArgs: string[] = [];
    for (const arg of args) {
      // Skip option flags (e.g., --output, -o)
      if (arg.startsWith('-')) {
        sanitizedArgs.push(arg);
        continue;
      }

      // Validate potential file path arguments
      try {
        // Check if looks like file path
        if (arg.includes('/') || arg.includes('\\') || arg.includes('.')) {
          this.sanitizeFilePath(arg);
        }
        sanitizedArgs.push(arg);
      } catch (error) {
        return {
          success: false,
          message: `Security error: Invalid argument - ${error instanceof Error ? error.message : 'unknown'}`,
        };
      }
    }

    return new Promise((resolve) => {
      const timeout = options?.timeout || 1800000; // Default 30 minutes

      options?.onProgress?.(`Executing ${command}...`, 0);

      // @security On Windows, npm global commands need special handling
      const isWindows = process.platform === 'win32';
      // On Windows use shell: true to avoid spawn EINVAL and find commands properly
      const useShell = isWindows;
      const actualCommand = command;

      const child = spawn(actualCommand, sanitizedArgs, {
        cwd: options?.workingDirectory || process.cwd(),
        env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
        shell: useShell,
        windowsHide: true,
      });

      this.currentProcess = child;

      let stdout = '';
      let stderr = '';
      let lastProgress = 0;

      // Set timeout
      const timeoutId = setTimeout(() => {
        if (child && !child.killed) {
          this.killCurrentProcess();
          resolve({
            success: false,
            message: `Command execution timeout (${timeout / 1000}s)`,
          });
        }
      }, timeout);

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');

      child.stdout?.on('data', (data) => {
        const output = this.cleanAnsiCodes(data.toString());
        stdout += output;

        // Parse progress
        const progressMatch = output.match(/(\d+)%/);
        if (progressMatch) {
          lastProgress = Number.parseInt(progressMatch[1]);
        }

        options?.onProgress?.(output.trim(), lastProgress);
      });

      child.stderr?.on('data', (data) => {
        stderr += this.cleanAnsiCodes(data.toString());
      });

      child.on('close', (code) => {
        clearTimeout(timeoutId);
        this.currentProcess = null;

        if (code === 0) {
          resolve({
            success: true,
            message: 'Execution succeeded',
            data: { stdout, stderr },
            progress: 100,
          });
        } else {
          resolve({
            success: false,
            message: `Execution failed (Exit Code: ${code}): ${stderr || stdout}`,
            data: { stdout, stderr },
          });
        }
      });

      child.on('error', (err) => {
        clearTimeout(timeoutId);
        this.currentProcess = null;

        resolve({
          success: false,
          message: `Command execution failed: ${err.message}\n`,
        });
      });
    });
  }

  /**
   * Cleans ANSI control codes.
   */
  private cleanAnsiCodes(text: string): string {
    return text
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }
}

/**
 * Creates AgentService instance.
 * Used for ServiceContainer registration.
 */
export function createAgentService(configManager: IConfigManager): IAgentService {
  return new AgentService(configManager);
}
