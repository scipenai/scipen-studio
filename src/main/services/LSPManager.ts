/**
 * @file LSPManager - Multi-LSP service router
 * @description Routes LSP requests to appropriate language servers based on file type
 * @depends TexLabService, TinymistService
 *
 * Supported servers:
 * - TexLab: LaTeX files (.tex, .latex, .ltx, .sty, .cls, .bib)
 * - Tinymist: Typst files (.typ)
 *
 * Process cleanup:
 * - Registers app.on('before-quit') for graceful shutdown
 * - Handles SIGINT, SIGTERM, SIGHUP for abnormal exit
 * - emergencyCleanup() force-kills all child processes to prevent zombies
 */

import { EventEmitter } from 'events';
import type {
  BaseLSPService,
  LSPCompletionItem,
  LSPDiagnostic,
  LSPDocumentSymbol,
  LSPHover,
  LSPLocation,
  LSPRange,
  LSPStartOptions,
  LSPSymbol,
  LSPTextDocumentContentChangeEvent,
} from './BaseLSPService';
import { createLogger } from './LoggerService';
import { type TexLabService, getTexLabService } from './TexLabService';
import { type TinymistService, getTinymistService } from './TinymistService';

const logger = createLogger('LSPManager');

// Re-export types
export type {
  LSPCompletionItem,
  LSPDiagnostic,
  LSPDocumentSymbol,
  LSPHover,
  LSPLocation,
  LSPSymbol,
  LSPRange,
  LSPStartOptions,
  LSPTextDocumentContentChangeEvent,
};

// ====== LSP Availability Info ======

export interface LSPAvailability {
  texlab: boolean;
  tinymist: boolean;
  texlabVersion: string | null;
  tinymistVersion: string | null;
}

// ====== Lazy Loading Configuration ======

const AUTO_SHUTDOWN_TIMEOUT_MS = 5 * 60 * 1000; // 5min after last file closed
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_COOLDOWN_MS = 30 * 1000; // 30s between restart attempts
const RESTART_RESET_DELAY_MS = 60 * 1000; // Reset counter after stable run

type LSPServiceType = 'texlab' | 'tinymist';

// ====== LSP Manager Class ======

export class LSPManager extends EventEmitter {
  private texlabService: TexLabService;
  private tinymistService: TinymistService;
  private rootPath: string | null = null;
  private startOptions: LSPStartOptions | undefined;

  // ====== Lazy Loading State ======

  private configured = false;
  private activeLatexFiles: Set<string> = new Set();
  private activeTypstFiles: Set<string> = new Set();
  private texlabShutdownTimer: ReturnType<typeof setTimeout> | null = null;
  private tinymistShutdownTimer: ReturnType<typeof setTimeout> | null = null;

  // ====== Auto-Restart State ======

  private restartAttempts: Map<LSPServiceType, number> = new Map();
  private lastRestartTime: Map<LSPServiceType, number> = new Map();
  private restartResetTimers: Map<LSPServiceType, ReturnType<typeof setTimeout>> = new Map();
  private exitHandlersRegistered = false;

  constructor() {
    super();
    this.texlabService = getTexLabService();
    this.tinymistService = getTinymistService();

    // Forward events
    this.setupEventForwarding();

    // Register process exit cleanup handlers
    this.registerExitHandlers();
  }

  /** Prevents zombie LSP processes on exit (normal or abnormal) */
  private registerExitHandlers(): void {
    if (this.exitHandlersRegistered) {
      return;
    }
    this.exitHandlersRegistered = true;

    // Only register in main process - app module behaves differently in UtilityProcess
    if ((process as NodeJS.Process & { type?: string }).type === 'browser') {
      try {
        const { app } = require('electron');
        if (app && typeof app.on === 'function') {
          app.on('before-quit', async () => {
            logger.info('[LSPManager] App quitting, stopping all LSP services...');
            try {
              await this.stop();
            } catch (e) {
              console.error('[LSPManager] Error stopping LSP services:', e);
              // Even if normal stop fails, try emergency cleanup
              this.emergencyCleanup();
            }
          });
        }
      } catch {
        // Cannot access app in UtilityProcess
      }
    }

    // Handle process signals (abnormal exit scenarios)
    const signalHandler = (signal: string) => {
      logger.info(`[LSPManager] Received ${signal}, emergency cleanup...`);
      this.emergencyCleanup();
    };

    process.on('SIGINT', () => signalHandler('SIGINT'));
    process.on('SIGTERM', () => signalHandler('SIGTERM'));

    // Windows special handling: SIGHUP is rare on Windows, but included just in case
    if (process.platform === 'win32') {
      process.on('SIGHUP', () => signalHandler('SIGHUP'));
    }

    // Attempt to clean up LSP child processes on uncaught exceptions
    // Note: Do not call process.exit() in Electron environment,
    // as main process has its own error handling mechanism
    process.on('uncaughtException', (error) => {
      console.error('[LSPManager] Uncaught exception, emergency cleanup:', error.message);
      this.emergencyCleanup();
      // Do not call process.exit(), let Electron main process error handler continue
    });
  }

  /** SIGKILL all LSP processes - for abnormal exits */
  emergencyCleanup(): void {
    logger.info('[LSPManager] Emergency cleanup triggered');

    // Access internal process property and force terminate
    // Note: Use unknown instead of any, with type guard
    try {
      const texlabProcess = (
        this.texlabService as unknown as {
          process?: { killed?: boolean; kill: (signal: string) => void };
        }
      ).process;
      if (texlabProcess && !texlabProcess.killed) {
        logger.info('[LSPManager] Force killing TexLab process');
        texlabProcess.kill('SIGKILL');
      }
    } catch {
      logger.error('[LSPManager] Error killing TexLab');
    }

    try {
      const tinymistProcess = (
        this.tinymistService as unknown as {
          process?: { killed?: boolean; kill: (signal: string) => void };
        }
      ).process;
      if (tinymistProcess && !tinymistProcess.killed) {
        logger.info('[LSPManager] Force killing Tinymist process');
        tinymistProcess.kill('SIGKILL');
      }
    } catch {
      logger.error('[LSPManager] Error killing Tinymist');
    }
  }

  private setupEventForwarding(): void {
    // TexLab events
    this.texlabService.on('diagnostics', (data) => {
      this.emit('diagnostics', { ...data, source: 'texlab' });
    });
    this.texlabService.on('initialized', () => {
      this.emit('initialized', { source: 'texlab' });
    });
    this.texlabService.on('exit', (data: { code: number | null; signal: string | null }) => {
      this.emit('exit', { ...data, source: 'texlab' });
      // Detect abnormal exit (non-zero code or signal) and attempt auto-restart
      if (data.code !== 0 || data.signal) {
        this.handleServiceCrash(
          'texlab',
          new Error(`TexLab exited with code ${data.code}, signal ${data.signal}`)
        );
      }
    });
    this.texlabService.on('error', (error) => {
      this.emit('error', { error, source: 'texlab' });
      // Errors may also make service unavailable, attempt restart
      this.handleServiceCrash('texlab', error instanceof Error ? error : new Error(String(error)));
    });

    // Tinymist events
    this.tinymistService.on('diagnostics', (data) => {
      this.emit('diagnostics', { ...data, source: 'tinymist' });
    });
    this.tinymistService.on('initialized', () => {
      this.emit('initialized', { source: 'tinymist' });
    });
    this.tinymistService.on('exit', (data: { code: number | null; signal: string | null }) => {
      this.emit('exit', { ...data, source: 'tinymist' });
      // Detect abnormal exit (non-zero code or signal) and attempt auto-restart
      if (data.code !== 0 || data.signal) {
        this.handleServiceCrash(
          'tinymist',
          new Error(`Tinymist exited with code ${data.code}, signal ${data.signal}`)
        );
      }
    });
    this.tinymistService.on('error', (error) => {
      this.emit('error', { error, source: 'tinymist' });
      // Errors may also make service unavailable, attempt restart
      this.handleServiceCrash(
        'tinymist',
        error instanceof Error ? error : new Error(String(error))
      );
    });
  }

  private async handleServiceCrash(serviceType: LSPServiceType, error: Error): Promise<void> {
    // Skip restart if not configured or no active files
    if (!this.configured || !this.rootPath) {
      logger.info(
        `[LSPManager] ${serviceType} crashed but no active configuration, skipping restart`
      );
      return;
    }

    // Check if there are active files of the corresponding type
    const hasActiveFiles =
      serviceType === 'texlab' ? this.activeLatexFiles.size > 0 : this.activeTypstFiles.size > 0;

    if (!hasActiveFiles) {
      logger.info(`[LSPManager] ${serviceType} crashed but no active files, skipping restart`);
      return;
    }

    const attempts = this.restartAttempts.get(serviceType) || 0;
    const lastRestart = this.lastRestartTime.get(serviceType) || 0;
    const now = Date.now();

    // Check cooldown period
    if (now - lastRestart < RESTART_COOLDOWN_MS) {
      logger.info(
        `[LSPManager] ${serviceType} restart cooldown active (${Math.ceil((RESTART_COOLDOWN_MS - (now - lastRestart)) / 1000)}s remaining), skipping`
      );
      return;
    }

    // Check restart attempt limit
    if (attempts >= MAX_RESTART_ATTEMPTS) {
      console.error(
        `[LSPManager] ${serviceType} exceeded max restart attempts (${MAX_RESTART_ATTEMPTS})`
      );
      this.emit('serviceCrashed', {
        service: serviceType,
        error,
        recoverable: false,
        message: `${serviceType} crashed repeatedly and will not be restarted automatically. Please restart the IDE.`,
      });
      return;
    }

    logger.info(
      `[LSPManager] Attempting to restart ${serviceType} (attempt ${attempts + 1}/${MAX_RESTART_ATTEMPTS})`
    );

    // Update restart state
    this.restartAttempts.set(serviceType, attempts + 1);
    this.lastRestartTime.set(serviceType, now);

    // Emit restart event
    this.emit('serviceRestarting', { service: serviceType, attempt: attempts + 1 });

    try {
      let success = false;

      if (serviceType === 'texlab') {
        // Ensure service is stopped
        await this.texlabService.stop().catch(() => {});
        // Restart
        success = await this.texlabService.start(this.rootPath, this.startOptions);

        if (success) {
          // Re-open active files
          for (const filePath of this.activeLatexFiles) {
            try {
              // Note: We don't have content, LSP needs to re-read from filesystem
              // or renderer needs to re-send didOpen
              logger.info(`[LSPManager] Re-tracking LaTeX file: ${filePath}`);
            } catch (e) {
              console.error(`[LSPManager] Failed to re-open file ${filePath}:`, e);
            }
          }
        }
      } else if (serviceType === 'tinymist') {
        // Ensure service is stopped
        await this.tinymistService.stop().catch(() => {});
        // Restart
        success = await this.tinymistService.start(this.rootPath, this.startOptions);

        if (success) {
          // Re-open active files
          for (const filePath of this.activeTypstFiles) {
            try {
              logger.info(`[LSPManager] Re-tracking Typst file: ${filePath}`);
            } catch (e) {
              console.error(`[LSPManager] Failed to re-open file ${filePath}:`, e);
            }
          }
        }
      }

      if (success) {
        logger.info(`[LSPManager] ${serviceType} restarted successfully`);
        // Emit restart success event, triggers renderer to re-sync documents
        // Event is forwarded to renderer via LSP_ServiceRestarted channel
        this.emit('serviceRestarted', { service: serviceType });

        // Set delayed counter reset (reset after service runs stably)
        const existingTimer = this.restartResetTimers.get(serviceType);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        const resetTimer = setTimeout(() => {
          logger.info(`[LSPManager] Resetting restart counter for ${serviceType}`);
          this.restartAttempts.set(serviceType, 0);
          this.restartResetTimers.delete(serviceType);
        }, RESTART_RESET_DELAY_MS);

        this.restartResetTimers.set(serviceType, resetTimer);
      } else {
        console.error(`[LSPManager] Failed to restart ${serviceType}`);
        this.emit('serviceCrashed', {
          service: serviceType,
          error: new Error(`Failed to restart ${serviceType}`),
          recoverable: attempts + 1 < MAX_RESTART_ATTEMPTS,
          message: `Failed to restart ${serviceType}. Will retry if more attempts are available.`,
        });
      }
    } catch (restartError) {
      console.error(`[LSPManager] Error during ${serviceType} restart:`, restartError);
      this.emit('serviceCrashed', {
        service: serviceType,
        error: restartError instanceof Error ? restartError : new Error(String(restartError)),
        recoverable: attempts + 1 < MAX_RESTART_ATTEMPTS,
        message: `Error restarting ${serviceType}: ${restartError}`,
      });
    }
  }

  // ====== Routing Logic ======

  getServiceForFile(filePath: string): BaseLSPService | null {
    const ext = this.getFileExtension(filePath);

    // Typst files
    if (this.tinymistService.getSupportedExtensions().includes(ext)) {
      return this.tinymistService;
    }

    // LaTeX files
    if (this.texlabService.getSupportedExtensions().includes(ext)) {
      return this.texlabService;
    }

    return null;
  }

  private getFileExtension(filePath: string): string {
    const match = filePath.match(/\.[^.]+$/);
    return match ? match[0].toLowerCase() : '';
  }

  isTypstFile(filePath: string): boolean {
    return this.getFileExtension(filePath) === '.typ';
  }

  /**
   * Check if file is a LaTeX file
   */
  isLatexFile(filePath: string): boolean {
    const ext = this.getFileExtension(filePath);
    return this.texlabService.getSupportedExtensions().includes(ext);
  }

  // ====== Availability Checks ======

  async checkAvailability(): Promise<LSPAvailability> {
    const [texlabAvailable, tinymistAvailable, texlabVersion, tinymistVersion] = await Promise.all([
      this.texlabService.isAvailable(),
      this.tinymistService.isAvailable(),
      this.texlabService.getVersion(),
      this.tinymistService.getVersion(),
    ]);

    return {
      texlab: texlabAvailable,
      tinymist: tinymistAvailable,
      texlabVersion,
      tinymistVersion,
    };
  }

  async isAnyAvailable(): Promise<boolean> {
    const availability = await this.checkAvailability();
    return availability.texlab || availability.tinymist;
  }

  async isTexLabAvailable(): Promise<boolean> {
    return this.texlabService.isAvailable();
  }

  async isTinymistAvailable(): Promise<boolean> {
    return this.tinymistService.isAvailable();
  }

  async getTexLabVersion(): Promise<string | null> {
    return this.texlabService.getVersion();
  }

  async getTinymistVersion(): Promise<string | null> {
    return this.tinymistService.getVersion();
  }

  // ====== Lifecycle Management ======

  /**
   * Configures manager but doesn't start services (lazy mode).
   * Services start on-demand when files are first opened.
   */
  async start(
    rootPath: string,
    options?: LSPStartOptions
  ): Promise<{ texlab: boolean; tinymist: boolean }> {
    this.rootPath = rootPath;
    this.startOptions = options;
    this.configured = true;

    logger.info(
      '[LSPManager] Configuration complete, lazy mode enabled. Services will start on first file open.'
    );

    // Lazy mode: don't start services immediately, return true for "configuration success"
    // This differs from old behavior which started all services immediately
    // If caller explicitly wants immediate start, call startAllNow()
    return { texlab: true, tinymist: true };
  }

  /** Starts all services immediately (bypasses lazy mode) */
  async startAllNow(
    rootPath?: string,
    options?: LSPStartOptions
  ): Promise<{ texlab: boolean; tinymist: boolean }> {
    const path = rootPath || this.rootPath;
    if (!path) return { texlab: false, tinymist: false };

    this.rootPath = path;
    this.startOptions = options || this.startOptions;
    this.configured = true;

    const [texlabStarted, tinymistStarted] = await Promise.all([
      this.startTexLabNow(path, this.startOptions),
      this.startTinymistNow(path, this.startOptions),
    ]);

    return { texlab: texlabStarted, tinymist: tinymistStarted };
  }

  /**
   * Start service on-demand (internal method)
   * Called automatically when opening documents
   */
  private async ensureServiceForFile(filePath: string): Promise<BaseLSPService | null> {
    if (!this.configured || !this.rootPath) {
      return null;
    }

    const ext = this.getFileExtension(filePath);

    // Typst files
    if (this.tinymistService.getSupportedExtensions().includes(ext)) {
      return this.ensureTinymist();
    }

    // LaTeX files
    if (this.texlabService.getSupportedExtensions().includes(ext)) {
      return this.ensureTexLab();
    }

    return null;
  }

  private async ensureTexLab(): Promise<TexLabService | null> {
    // Cancel auto-shutdown timer
    if (this.texlabShutdownTimer) {
      clearTimeout(this.texlabShutdownTimer);
      this.texlabShutdownTimer = null;
    }

    if (this.texlabService.isRunning()) {
      return this.texlabService;
    }

    if (!this.rootPath) return null;

    logger.info('[LSPManager] Lazy-starting TexLab...');
    const started = await this.texlabService.start(this.rootPath, this.startOptions);

    if (started) {
      logger.info('[LSPManager] TexLab started successfully');
      this.emit('serviceStarted', { service: 'texlab' });
      return this.texlabService;
    }

    console.error('[LSPManager] TexLab failed to start');
    return null;
  }

  private async ensureTinymist(): Promise<TinymistService | null> {
    // Cancel auto-shutdown timer
    if (this.tinymistShutdownTimer) {
      clearTimeout(this.tinymistShutdownTimer);
      this.tinymistShutdownTimer = null;
    }

    if (this.tinymistService.isRunning()) {
      return this.tinymistService;
    }

    if (!this.rootPath) return null;

    logger.info('[LSPManager] Lazy-starting Tinymist...');
    const started = await this.tinymistService.start(this.rootPath, this.startOptions);

    if (started) {
      logger.info('[LSPManager] Tinymist started successfully');
      this.emit('serviceStarted', { service: 'tinymist' });
      return this.tinymistService;
    }

    console.error('[LSPManager] Tinymist failed to start');
    return null;
  }

  async startTexLab(rootPath?: string, options?: LSPStartOptions): Promise<boolean> {
    return this.startTexLabNow(rootPath, options);
  }

  private async startTexLabNow(rootPath?: string, options?: LSPStartOptions): Promise<boolean> {
    const path = rootPath || this.rootPath;
    if (!path) return false;

    // Cancel auto-shutdown
    if (this.texlabShutdownTimer) {
      clearTimeout(this.texlabShutdownTimer);
      this.texlabShutdownTimer = null;
    }

    const opts = options || this.startOptions;
    const result = await this.texlabService.start(path, opts);

    if (result) {
      this.emit('serviceStarted', { service: 'texlab' });
    }

    return result;
  }

  async startTinymist(rootPath?: string, options?: LSPStartOptions): Promise<boolean> {
    return this.startTinymistNow(rootPath, options);
  }

  private async startTinymistNow(rootPath?: string, options?: LSPStartOptions): Promise<boolean> {
    const path = rootPath || this.rootPath;
    if (!path) return false;

    // Cancel auto-shutdown
    if (this.tinymistShutdownTimer) {
      clearTimeout(this.tinymistShutdownTimer);
      this.tinymistShutdownTimer = null;
    }

    const opts = options || this.startOptions;
    const result = await this.tinymistService.start(path, opts);

    if (result) {
      this.emit('serviceStarted', { service: 'tinymist' });
    }

    return result;
  }

  async stop(): Promise<void> {
    // Clear all timers
    if (this.texlabShutdownTimer) {
      clearTimeout(this.texlabShutdownTimer);
      this.texlabShutdownTimer = null;
    }
    if (this.tinymistShutdownTimer) {
      clearTimeout(this.tinymistShutdownTimer);
      this.tinymistShutdownTimer = null;
    }

    // Clear restart counter reset timers
    for (const timer of this.restartResetTimers.values()) {
      clearTimeout(timer);
    }
    this.restartResetTimers.clear();
    this.restartAttempts.clear();
    this.lastRestartTime.clear();

    // Clear active file tracking
    this.activeLatexFiles.clear();
    this.activeTypstFiles.clear();

    await Promise.all([this.texlabService.stop(), this.tinymistService.stop()]);

    this.rootPath = null;
    this.startOptions = undefined;
    this.configured = false;
  }

  /**
   * Check auto-shutdown (internal method)
   * Called when reference count for a file type reaches zero
   */
  private scheduleAutoShutdown(serviceType: LSPServiceType): void {
    if (serviceType === 'texlab') {
      // Don't shutdown if there are still active LaTeX files
      if (this.activeLatexFiles.size > 0) return;

      // No need to shutdown if TexLab isn't running
      if (!this.texlabService.isRunning()) return;

      logger.info(
        `[LSPManager] No active LaTeX files, auto-shutdown TexLab in ${AUTO_SHUTDOWN_TIMEOUT_MS / 1000}s`
      );

      this.texlabShutdownTimer = setTimeout(async () => {
        // Re-check if still no active files
        if (this.activeLatexFiles.size === 0 && this.texlabService.isRunning()) {
          logger.info('[LSPManager] Auto-shutdown TexLab');
          await this.texlabService.stop();
          this.emit('serviceStopped', { service: 'texlab' });
        }
      }, AUTO_SHUTDOWN_TIMEOUT_MS);
    } else if (serviceType === 'tinymist') {
      // Don't shutdown if there are still active Typst files
      if (this.activeTypstFiles.size > 0) return;

      // No need to shutdown if Tinymist isn't running
      if (!this.tinymistService.isRunning()) return;

      logger.info(
        `[LSPManager] No active Typst files, auto-shutdown Tinymist in ${AUTO_SHUTDOWN_TIMEOUT_MS / 1000}s`
      );

      this.tinymistShutdownTimer = setTimeout(async () => {
        // Re-check if still no active files
        if (this.activeTypstFiles.size === 0 && this.tinymistService.isRunning()) {
          logger.info('[LSPManager] Auto-shutdown Tinymist');
          await this.tinymistService.stop();
          this.emit('serviceStopped', { service: 'tinymist' });
        }
      }, AUTO_SHUTDOWN_TIMEOUT_MS);
    }
  }

  isAnyRunning(): boolean {
    return this.texlabService.isRunning() || this.tinymistService.isRunning();
  }

  isRunning(filePath?: string): boolean {
    if (!filePath) {
      return this.isAnyRunning();
    }
    const service = this.getServiceForFile(filePath);
    return service?.isRunning() ?? false;
  }

  isVirtualMode(): boolean {
    return this.texlabService.isVirtualMode() || this.tinymistService.isVirtualMode();
  }

  isConfigured(): boolean {
    return this.configured;
  }

  getActiveFileStats(): { latex: number; typst: number } {
    return {
      latex: this.activeLatexFiles.size,
      typst: this.activeTypstFiles.size,
    };
  }

  // ====== Document Operations ======

  /** Triggers lazy service startup if needed */
  async openDocument(filePath: string, content: string, languageId?: string): Promise<void> {
    // Lazy start: ensure corresponding LSP service is started
    const service = await this.ensureServiceForFile(filePath);
    if (!service) return;

    // Track active file
    this.trackFileOpened(filePath);

    await service.openDocument(filePath, content, languageId);
  }

  /**
   * Update document (full content, supports lazy start)
   * BaseLSPService.updateDocument automatically handles unopened documents
   */
  async updateDocument(filePath: string, content: string): Promise<void> {
    // Ensure service is started (lazy start)
    const service = await this.ensureServiceForFile(filePath);
    if (!service) return;

    // BaseLSPService.updateDocument auto-opens unopened documents
    await service.updateDocument(filePath, content);

    // Track active file
    this.trackFileOpened(filePath);
  }

  async updateDocumentIncremental(
    filePath: string,
    changes: LSPTextDocumentContentChangeEvent[]
  ): Promise<void> {
    // No need for ensureService, document should already be open before update
    const service = this.getServiceForFile(filePath);
    if (service?.isRunning()) {
      await service.updateDocumentIncremental(filePath, changes);
    }
  }

  /**
   * Close document
   * Triggers active file count update, may cause LSP service auto-shutdown
   */
  async closeDocument(filePath: string): Promise<void> {
    const service = this.getServiceForFile(filePath);
    if (service?.isRunning()) {
      await service.closeDocument(filePath);
    }

    // Untrack and check if auto-shutdown needed
    this.trackFileClosed(filePath);
  }

  async saveDocument(filePath: string): Promise<void> {
    const service = this.getServiceForFile(filePath);
    if (service?.isRunning()) {
      await service.saveDocument(filePath);
    }
  }

  private trackFileOpened(filePath: string): void {
    const ext = this.getFileExtension(filePath);

    if (this.texlabService.getSupportedExtensions().includes(ext)) {
      // Cancel shutdown timer
      if (this.texlabShutdownTimer) {
        clearTimeout(this.texlabShutdownTimer);
        this.texlabShutdownTimer = null;
      }
      this.activeLatexFiles.add(filePath);
      logger.info(
        `[LSPManager] Tracking LaTeX file: ${filePath} (active: ${this.activeLatexFiles.size})`
      );
    } else if (this.tinymistService.getSupportedExtensions().includes(ext)) {
      // Cancel shutdown timer
      if (this.tinymistShutdownTimer) {
        clearTimeout(this.tinymistShutdownTimer);
        this.tinymistShutdownTimer = null;
      }
      this.activeTypstFiles.add(filePath);
      logger.info(
        `[LSPManager] Tracking Typst file: ${filePath} (active: ${this.activeTypstFiles.size})`
      );
    }
  }

  private trackFileClosed(filePath: string): void {
    const ext = this.getFileExtension(filePath);

    if (this.texlabService.getSupportedExtensions().includes(ext)) {
      this.activeLatexFiles.delete(filePath);
      logger.info(
        `[LSPManager] Closed LaTeX file: ${filePath} (active: ${this.activeLatexFiles.size})`
      );

      // Schedule auto-shutdown if no active files left
      if (this.activeLatexFiles.size === 0) {
        this.scheduleAutoShutdown('texlab');
      }
    } else if (this.tinymistService.getSupportedExtensions().includes(ext)) {
      this.activeTypstFiles.delete(filePath);
      logger.info(
        `[LSPManager] Closed Typst file: ${filePath} (active: ${this.activeTypstFiles.size})`
      );

      // Schedule auto-shutdown if no active files left
      if (this.activeTypstFiles.size === 0) {
        this.scheduleAutoShutdown('tinymist');
      }
    }
  }

  // ====== Language Features ======

  /**
   * Get completion suggestions (supports lazy start)
   */
  async getCompletions(
    filePath: string,
    line: number,
    character: number
  ): Promise<LSPCompletionItem[]> {
    // Use ensureServiceForFile to ensure service is started (lazy start)
    const service = await this.ensureServiceForFile(filePath);
    if (!service) return [];
    return service.getCompletions(filePath, { line, character });
  }

  async getHover(filePath: string, line: number, character: number): Promise<LSPHover | null> {
    const service = await this.ensureServiceForFile(filePath);
    if (!service) return null;
    return service.getHover(filePath, { line, character });
  }

  async getDefinition(
    filePath: string,
    line: number,
    character: number
  ): Promise<LSPLocation | LSPLocation[] | null> {
    const service = await this.ensureServiceForFile(filePath);
    if (!service) return null;
    return service.getDefinition(filePath, { line, character });
  }

  async getReferences(
    filePath: string,
    line: number,
    character: number,
    includeDeclaration?: boolean
  ): Promise<LSPLocation[]> {
    const service = await this.ensureServiceForFile(filePath);
    if (!service) return [];
    return service.getReferences(filePath, { line, character }, includeDeclaration);
  }

  /**
   * Get document symbols (supports lazy start)
   */
  async getDocumentSymbols(filePath: string): Promise<LSPDocumentSymbol[] | LSPSymbol[]> {
    const service = await this.ensureServiceForFile(filePath);
    if (!service) return [];
    return service.getDocumentSymbols(filePath);
  }

  // ====== Specialized Feature Proxies ======

  async build(filePath: string): Promise<{ status: string }> {
    if (this.isLatexFile(filePath)) {
      return this.texlabService.build(filePath);
    }
    return { status: 'error' };
  }

  /**
   * TexLab: Forward search
   */
  async forwardSearch(filePath: string, line: number): Promise<{ status: string }> {
    if (this.isLatexFile(filePath)) {
      return this.texlabService.forwardSearch(filePath, line);
    }
    return { status: 'error' };
  }

  async exportTypstPdf(
    filePath: string
  ): Promise<{ success: boolean; pdfPath?: string; error?: string }> {
    if (this.isTypstFile(filePath)) {
      return this.tinymistService.exportPdf(filePath);
    }
    return { success: false, error: 'Not a Typst file' };
  }

  async formatTypstDocument(
    filePath: string
  ): Promise<{ edits: Array<{ range: LSPRange; newText: string }> }> {
    if (this.isTypstFile(filePath)) {
      const edits = await this.tinymistService.formatDocument(filePath);
      return { edits };
    }
    return { edits: [] };
  }

  // ====== Direct Service Access ======

  getTexLabService(): TexLabService {
    return this.texlabService;
  }

  getTinymistService(): TinymistService {
    return this.tinymistService;
  }
}

// Singleton instance
let lspManager: LSPManager | null = null;

export function getLSPManager(): LSPManager {
  if (!lspManager) {
    lspManager = new LSPManager();
  }
  return lspManager;
}
