/**
 * @file LSPProcessClient - Utility process proxy for LSP services
 * @description Manages LSP utility process lifecycle and proxies LSP requests
 * @depends electron utilityProcess, MessageChannelMain
 */

// ====== Design Notes ======
// - Keep main process responsive by running LSP in a utility process
// - MessagePort allows direct renderer <-> LSP channels when needed
// - Auto-restart recovers from LSP crashes with backoff

import { EventEmitter } from 'events';
import * as path from 'path';
import { MessageChannelMain, type UtilityProcess, app, utilityProcess } from 'electron';
import { createLogger } from './LoggerService';

const logger = createLogger('LSPProcessClient');

// ====== Type Definitions ======

interface LSPRequest {
  id: string;
  type: 'request';
  method: string;
  params: unknown;
}

interface LSPResponse {
  id: string;
  type: 'response';
  result?: unknown;
  error?: { code: number; message: string };
}

interface LSPEvent {
  type: 'event';
  event: string;
  data: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  timeout: ReturnType<typeof setTimeout>;
}

export interface LSPAvailability {
  texlab: boolean;
  tinymist: boolean;
  texlabVersion: string | null;
  tinymistVersion: string | null;
}

// ====== LSP Process Client ======

export class LSPProcessClient extends EventEmitter {
  private process: UtilityProcess | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private requestId = 0;
  private initialized = false;
  private starting = false;
  private restartAttempts = 0;
  private readonly MAX_RESTART_ATTEMPTS = 3;
  private readonly REQUEST_TIMEOUT_MS = 30000;
  // Exponential backoff configuration for restart attempts.
  private readonly RESTART_BASE_DELAY_MS = 1000;
  private readonly RESTART_MAX_DELAY_MS = 16000;

  // Cached state for restart recovery.
  private rootPath: string | null = null;
  private startOptions: { virtual?: boolean } | undefined;

  private getProcessPath(): string {
    if (app.isPackaged) {
      // Packaged build: load from resources.
      return path.join(
        process.resourcesPath,
        'app.asar',
        'out',
        'main',
        'lsp-process',
        'index.cjs'
      );
    } else {
      // Development: load from out directory.
      return path.join(__dirname, 'lsp-process', 'index.cjs');
    }
  }

  /** @sideeffect Spawns UtilityProcess and wires listeners */
  async startProcess(): Promise<boolean> {
    if (this.process) {
      return true;
    }

    if (this.starting) {
      // Wait for the in-flight startup attempt.
      return new Promise((resolve) => {
        const checkStarted = setInterval(() => {
          if (!this.starting) {
            clearInterval(checkStarted);
            resolve(this.process !== null);
          }
        }, 100);
      });
    }

    this.starting = true;

    try {
      const processPath = this.getProcessPath();
      logger.info(`[LSPProcessClient] Starting LSP process: ${processPath}`);

      this.process = utilityProcess.fork(processPath, [], {
        serviceName: 'scipen-lsp',
        // Allow native Node modules.
        execArgv: [],
        // Inject paths and config via env; utility process cannot call app.getPath().
        env: {
          ...process.env,
          LOGS_DIR: path.join(app.getPath('userData'), 'logs'),
          USER_DATA_PATH: app.getPath('userData'),
          APP_LOCALE: app.getLocale(),
        },
      });

      // Wire message handling.
      this.process.on('message', (message: LSPResponse | LSPEvent) => {
        this.handleMessage(message);
      });

      // Handle process exit.
      this.process.on('exit', (code) => {
        logger.info(`[LSPProcessClient] LSP process exited with code: ${code}`);
        this.process = null;
        this.initialized = false;

        // Reject all pending requests.
        for (const [, pending] of this.pendingRequests) {
          clearTimeout(pending.timeout);
          pending.reject(new Error(`LSP process exited (${code})`));
        }
        this.pendingRequests.clear();

        // Attempt auto-restart with exponential backoff.
        if (code !== 0 && this.restartAttempts < this.MAX_RESTART_ATTEMPTS) {
          this.restartAttempts++;
          // Backoff: 1s -> 2s -> 4s -> 8s -> 16s (max).
          const delay = Math.min(
            this.RESTART_BASE_DELAY_MS * Math.pow(2, this.restartAttempts - 1),
            this.RESTART_MAX_DELAY_MS
          );
          logger.info(
            `[LSPProcessClient] Restarting LSP process (${this.restartAttempts}/${this.MAX_RESTART_ATTEMPTS}), delay ${delay}ms`
          );
          setTimeout(() => this.recoverProcess(), delay);
        }

        this.emit('exit', { code });
      });

      // Initialize LSP manager in the utility process.
      await this.sendRequest('initialize', {});
      this.initialized = true;
      this.restartAttempts = 0;

      logger.info('[LSPProcessClient] LSP process started and initialized');
      return true;
    } catch (error) {
      console.error('[LSPProcessClient] Failed to start LSP process:', error);
      this.process?.kill();
      this.process = null;
      return false;
    } finally {
      this.starting = false;
    }
  }

  /** Re-applies config after auto-restart */
  private async recoverProcess(): Promise<void> {
    const started = await this.startProcess();
    if (started && this.rootPath) {
      // Re-apply LSP manager configuration.
      await this.start(this.rootPath, this.startOptions);
      this.emit('recovered');
    }
  }

  async stopProcess(): Promise<void> {
    if (!this.process) return;

    try {
      await this.sendRequest('stop', {});
    } catch {
      // Ignore stop errors to allow forced shutdown.
    }

    this.process.kill();
    this.process = null;
    this.initialized = false;
    this.rootPath = null;
    this.startOptions = undefined;
  }

  /** Returns channel.port1 for renderer; port2 is sent to LSP process */
  createRendererChannel(): MessageChannelMain | null {
    if (!this.process) {
      console.error('[LSPProcessClient] LSP process not running; cannot create renderer channel');
      return null;
    }

    const channel = new MessageChannelMain();

    // Send port2 to the LSP process.
    this.process.postMessage({ type: 'port', port: channel.port2 }, [channel.port2]);

    // Caller can pass port1 to the renderer.
    return channel;
  }

  /** @throws when process is not running or request times out */
  private sendRequest(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process) {
        reject(new Error('LSP process is not running'));
        return;
      }

      const id = `req_${++this.requestId}`;
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timed out: ${method}`));
      }, this.REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, method, timeout });

      const request: LSPRequest = {
        id,
        type: 'request',
        method,
        params,
      };

      this.process.postMessage(request);
    });
  }

  private handleMessage(message: LSPResponse | LSPEvent): void {
    if (message.type === 'response') {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(message.id);

        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
    } else if (message.type === 'event') {
      // Re-emit events to consumers.
      this.emit(message.event, message.data);
    }
  }

  // ====== LSP Manager Proxies ======

  private async ensureProcess(): Promise<void> {
    if (!this.process) {
      const started = await this.startProcess();
      if (!started) {
        throw new Error('Unable to start LSP process');
      }
    }
  }

  async checkAvailability(): Promise<LSPAvailability> {
    await this.ensureProcess();
    return this.sendRequest('checkAvailability', {}) as Promise<LSPAvailability>;
  }

  async start(
    rootPath: string,
    options?: { virtual?: boolean }
  ): Promise<{ texlab: boolean; tinymist: boolean }> {
    await this.ensureProcess();
    this.rootPath = rootPath;
    this.startOptions = options;
    return this.sendRequest('start', { rootPath, options }) as Promise<{
      texlab: boolean;
      tinymist: boolean;
    }>;
  }

  async stop(): Promise<void> {
    if (!this.process) return;
    await this.sendRequest('stop', {});
    this.rootPath = null;
    this.startOptions = undefined;
  }

  async isRunning(filePath?: string): Promise<boolean> {
    if (!this.process) return false;
    return this.sendRequest('isRunning', { filePath }) as Promise<boolean>;
  }

  async isVirtualMode(): Promise<boolean> {
    if (!this.process) return false;
    return this.sendRequest('isVirtualMode', {}) as Promise<boolean>;
  }

  // ====== Document Operations ======

  async openDocument(filePath: string, content: string, languageId?: string): Promise<void> {
    await this.ensureProcess();
    await this.sendRequest('openDocument', { filePath, content, languageId });
  }

  async updateDocument(filePath: string, content: string): Promise<void> {
    if (!this.process) return;
    await this.sendRequest('updateDocument', { filePath, content });
  }

  async updateDocumentIncremental(filePath: string, changes: unknown[]): Promise<void> {
    if (!this.process) return;
    await this.sendRequest('updateDocumentIncremental', { filePath, changes });
  }

  async closeDocument(filePath: string): Promise<void> {
    if (!this.process) return;
    await this.sendRequest('closeDocument', { filePath });
  }

  async saveDocument(filePath: string): Promise<void> {
    if (!this.process) return;
    await this.sendRequest('saveDocument', { filePath });
  }

  // ====== Language Features ======

  async getCompletions(filePath: string, line: number, character: number): Promise<unknown[]> {
    await this.ensureProcess();
    return this.sendRequest('getCompletions', { filePath, line, character }) as Promise<unknown[]>;
  }

  async getHover(filePath: string, line: number, character: number): Promise<unknown> {
    await this.ensureProcess();
    return this.sendRequest('getHover', { filePath, line, character });
  }

  async getDefinition(filePath: string, line: number, character: number): Promise<unknown> {
    await this.ensureProcess();
    return this.sendRequest('getDefinition', { filePath, line, character });
  }

  async getReferences(
    filePath: string,
    line: number,
    character: number,
    includeDeclaration?: boolean
  ): Promise<unknown[]> {
    await this.ensureProcess();
    return this.sendRequest('getReferences', {
      filePath,
      line,
      character,
      includeDeclaration,
    }) as Promise<unknown[]>;
  }

  async getDocumentSymbols(filePath: string): Promise<unknown[]> {
    await this.ensureProcess();
    return this.sendRequest('getDocumentSymbols', { filePath }) as Promise<unknown[]>;
  }

  // ====== Language-Specific Features ======

  async build(filePath: string): Promise<{ status: string }> {
    await this.ensureProcess();
    return this.sendRequest('build', { filePath }) as Promise<{ status: string }>;
  }

  async forwardSearch(filePath: string, line: number): Promise<{ status: string }> {
    await this.ensureProcess();
    return this.sendRequest('forwardSearch', { filePath, line }) as Promise<{ status: string }>;
  }

  async exportTypstPdf(
    filePath: string
  ): Promise<{ success: boolean; pdfPath?: string; error?: string }> {
    await this.ensureProcess();
    return this.sendRequest('exportTypstPdf', { filePath }) as Promise<{
      success: boolean;
      pdfPath?: string;
      error?: string;
    }>;
  }

  async formatTypstDocument(filePath: string): Promise<{ edits: unknown[] }> {
    await this.ensureProcess();
    return this.sendRequest('formatTypstDocument', { filePath }) as Promise<{ edits: unknown[] }>;
  }

  isProcessAlive(): boolean {
    return this.process !== null;
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}

// ====== Singleton Access ======
let lspProcessClient: LSPProcessClient | null = null;

export function getLSPProcessClient(): LSPProcessClient {
  if (!lspProcessClient) {
    lspProcessClient = new LSPProcessClient();
  }
  return lspProcessClient;
}
