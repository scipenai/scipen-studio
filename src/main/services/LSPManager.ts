/**
 * @file LSPManager - Multi-LSP service router
 * @description Routes LSP requests to appropriate language servers based on file type
 * @depends TexLabService, TinymistService, MarkmanService
 *
 * Supported servers:
 * - TexLab: LaTeX files (.tex, .latex, .ltx, .sty, .cls, .bib)
 * - Tinymist: Typst files (.typ)
 * - Marksman: Markdown files (.md, .markdown)
 *
 * All per-service state (active files, shutdown timers) lives in one
 * `ServiceSlot` map so every lifecycle method is written once and iterated —
 * adding a fourth server is a constructor entry, not ten copy-pasted
 * branches.
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
import { type MarkmanService, getMarkmanService } from './MarkmanService';

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
  marksman: boolean;
  texlabVersion: string | null;
  tinymistVersion: string | null;
  marksmanVersion: string | null;
}

// ====== Lazy Loading Configuration ======

const AUTO_SHUTDOWN_TIMEOUT_MS = 5 * 60 * 1000; // 5min after last file closed
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_COOLDOWN_MS = 30 * 1000; // 30s between restart attempts
const RESTART_RESET_DELAY_MS = 60 * 1000; // Reset counter after stable run

type LSPServiceType = 'texlab' | 'tinymist' | 'marksman';

/** Per-server runtime state. Everything the manager tracks about one LSP
 * lives here — the methods below iterate slots instead of repeating
 * per-server branches. */
interface ServiceSlot {
  key: LSPServiceType;
  /** Human-readable name for logs ("TexLab"). */
  label: string;
  /** File-kind label for logs ("LaTeX" / "Typst" / "Markdown"). */
  fileKind: string;
  service: BaseLSPService;
  /** Files currently open in editors routed to this server. */
  activeFiles: Set<string>;
  /** Pending idle auto-shutdown timer, if armed. */
  shutdownTimer: ReturnType<typeof setTimeout> | null;
}

// ====== LSP Manager Class ======

export class LSPManager extends EventEmitter {
  /** Insertion order doubles as file-routing order. */
  private slots: Map<LSPServiceType, ServiceSlot>;
  private rootPath: string | null = null;
  private startOptions: LSPStartOptions | undefined;

  // ====== Lazy Loading State ======

  private configured = false;

  // ====== Auto-Restart State ======

  private restartAttempts: Map<LSPServiceType, number> = new Map();
  private lastRestartTime: Map<LSPServiceType, number> = new Map();
  private restartResetTimers: Map<LSPServiceType, ReturnType<typeof setTimeout>> = new Map();
  private exitHandlersRegistered = false;

  constructor() {
    super();
    this.slots = new Map<LSPServiceType, ServiceSlot>([
      [
        'tinymist',
        {
          key: 'tinymist',
          label: 'Tinymist',
          fileKind: 'Typst',
          service: getTinymistService(),
          activeFiles: new Set(),
          shutdownTimer: null,
        },
      ],
      [
        'texlab',
        {
          key: 'texlab',
          label: 'TexLab',
          fileKind: 'LaTeX',
          service: getTexLabService(),
          activeFiles: new Set(),
          shutdownTimer: null,
        },
      ],
      [
        'marksman',
        {
          key: 'marksman',
          label: 'Marksman',
          fileKind: 'Markdown',
          service: getMarkmanService(),
          activeFiles: new Set(),
          shutdownTimer: null,
        },
      ],
    ]);

    // Forward events
    this.setupEventForwarding();

    // Register process exit cleanup handlers
    this.registerExitHandlers();
  }

  private slot(key: LSPServiceType): ServiceSlot {
    const slot = this.slots.get(key);
    if (!slot) throw new Error(`Unknown LSP service type: ${key}`);
    return slot;
  }

  /** Route by file extension; null when no server claims the extension. */
  private slotForFile(filePath: string): ServiceSlot | null {
    const ext = this.getFileExtension(filePath);
    for (const slot of this.slots.values()) {
      if (slot.service.getSupportedExtensions().includes(ext)) return slot;
    }
    return null;
  }

  private cancelShutdownTimer(slot: ServiceSlot): void {
    if (slot.shutdownTimer) {
      clearTimeout(slot.shutdownTimer);
      slot.shutdownTimer = null;
    }
  }

  // Typed views for the few server-specific features (build / exportPdf /
  // forwardSearch). Everything else goes through the slot's BaseLSPService.
  private get texlabService(): TexLabService {
    return this.slot('texlab').service as TexLabService;
  }

  private get tinymistService(): TinymistService {
    return this.slot('tinymist').service as TinymistService;
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
    for (const slot of this.slots.values()) {
      try {
        const proc = (
          slot.service as unknown as {
            process?: { killed?: boolean; kill: (signal: string) => void };
          }
        ).process;
        if (proc && !proc.killed) {
          logger.info(`[LSPManager] Force killing ${slot.label} process`);
          proc.kill('SIGKILL');
        }
      } catch {
        logger.error(`[LSPManager] Error killing ${slot.label}`);
      }
    }
  }

  private setupEventForwarding(): void {
    for (const slot of this.slots.values()) {
      const { key, label, service } = slot;

      service.on('diagnostics', (data) => {
        this.emit('diagnostics', { ...data, source: key });
      });
      service.on('initialized', () => {
        this.emit('initialized', { source: key });
      });
      service.on('exit', (data: { code: number | null; signal: string | null }) => {
        this.emit('exit', { ...data, source: key });
        // Detect abnormal exit (non-zero code or signal) and attempt auto-restart
        if (data.code !== 0 || data.signal) {
          this.handleServiceCrash(
            key,
            new Error(`${label} exited with code ${data.code}, signal ${data.signal}`)
          );
        }
      });
      service.on('error', (error) => {
        this.emit('error', { error, source: key });
        // Errors may also make service unavailable, attempt restart
        this.handleServiceCrash(key, error instanceof Error ? error : new Error(String(error)));
      });
    }
  }

  private async handleServiceCrash(serviceType: LSPServiceType, error: Error): Promise<void> {
    // Skip restart if not configured or no active files
    if (!this.configured || !this.rootPath) {
      logger.info(
        `[LSPManager] ${serviceType} crashed but no active configuration, skipping restart`
      );
      return;
    }

    const slot = this.slot(serviceType);

    // Check if there are active files of the corresponding type
    if (slot.activeFiles.size === 0) {
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
      // Ensure service is stopped, then restart
      await slot.service.stop().catch(() => {});
      const success = await slot.service.start(this.rootPath, this.startOptions);

      if (success) {
        // Re-open active files. We don't have content here — LSP re-reads
        // from the filesystem or the renderer re-sends didOpen.
        for (const filePath of slot.activeFiles) {
          logger.info(`[LSPManager] Re-tracking ${slot.fileKind} file: ${filePath}`);
        }

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
    return this.slotForFile(filePath)?.service ?? null;
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
    return this.slot('texlab').service.getSupportedExtensions().includes(ext);
  }

  // ====== Availability Checks ======

  async checkAvailability(): Promise<LSPAvailability> {
    const availability: LSPAvailability = {
      texlab: false,
      tinymist: false,
      marksman: false,
      texlabVersion: null,
      tinymistVersion: null,
      marksmanVersion: null,
    };
    await Promise.all(
      [...this.slots.values()].map(async (slot) => {
        const [available, version] = await Promise.all([
          slot.service.isAvailable(),
          slot.service.getVersion(),
        ]);
        availability[slot.key] = available;
        availability[`${slot.key}Version`] = version;
      })
    );
    return availability;
  }

  async isTexLabAvailable(): Promise<boolean> {
    return this.slot('texlab').service.isAvailable();
  }

  async isTinymistAvailable(): Promise<boolean> {
    return this.slot('tinymist').service.isAvailable();
  }

  async getTexLabVersion(): Promise<string | null> {
    return this.slot('texlab').service.getVersion();
  }

  async getTinymistVersion(): Promise<string | null> {
    return this.slot('tinymist').service.getVersion();
  }

  // ====== Lifecycle Management ======

  /**
   * Configures manager but doesn't start services (lazy mode).
   * Services start on-demand when files are first opened.
   */
  async start(
    rootPath: string,
    options?: LSPStartOptions
  ): Promise<{ texlab: boolean; tinymist: boolean; marksman: boolean }> {
    this.rootPath = rootPath;
    this.startOptions = options;
    this.configured = true;

    logger.info(
      '[LSPManager] Configuration complete, lazy mode enabled. Services will start on first file open.'
    );

    // Lazy mode: don't start services immediately, return true for "configuration success"
    // This differs from old behavior which started all services immediately
    return { texlab: true, tinymist: true, marksman: true };
  }

  /**
   * Start service on-demand (internal method)
   * Called automatically when opening documents
   */
  private async ensureServiceForFile(filePath: string): Promise<BaseLSPService | null> {
    if (!this.configured || !this.rootPath) {
      return null;
    }
    const slot = this.slotForFile(filePath);
    if (!slot) return null;
    return this.ensureSlotStarted(slot);
  }

  /** Lazy-start one server: cancels its idle-shutdown timer, starts it if
   * needed, emits `serviceStarted` on a successful cold start. */
  private async ensureSlotStarted(slot: ServiceSlot): Promise<BaseLSPService | null> {
    this.cancelShutdownTimer(slot);

    if (slot.service.isRunning()) {
      return slot.service;
    }

    if (!this.rootPath) return null;

    logger.info(`[LSPManager] Lazy-starting ${slot.label}...`);
    const started = await slot.service.start(this.rootPath, this.startOptions);

    if (started) {
      logger.info(`[LSPManager] ${slot.label} started successfully`);
      this.emit('serviceStarted', { service: slot.key });
      return slot.service;
    }

    console.error(`[LSPManager] ${slot.label} failed to start`);
    return null;
  }

  async startTexLab(rootPath?: string, options?: LSPStartOptions): Promise<boolean> {
    return this.startServiceNow('texlab', rootPath, options);
  }

  async startTinymist(rootPath?: string, options?: LSPStartOptions): Promise<boolean> {
    return this.startServiceNow('tinymist', rootPath, options);
  }

  async startMarkman(rootPath?: string, options?: LSPStartOptions): Promise<boolean> {
    return this.startServiceNow('marksman', rootPath, options);
  }

  /** Immediate start of one server (bypasses lazy mode). */
  private async startServiceNow(
    key: LSPServiceType,
    rootPath?: string,
    options?: LSPStartOptions
  ): Promise<boolean> {
    const slot = this.slot(key);
    const path = rootPath || this.rootPath;
    if (!path) return false;

    // Cancel auto-shutdown
    this.cancelShutdownTimer(slot);

    const result = await slot.service.start(path, options || this.startOptions);

    if (result) {
      this.emit('serviceStarted', { service: key });
    }

    return result;
  }

  async stop(): Promise<void> {
    // Clear all timers
    for (const slot of this.slots.values()) {
      this.cancelShutdownTimer(slot);
      slot.activeFiles.clear();
    }

    // Clear restart counter reset timers
    for (const timer of this.restartResetTimers.values()) {
      clearTimeout(timer);
    }
    this.restartResetTimers.clear();
    this.restartAttempts.clear();
    this.lastRestartTime.clear();

    await Promise.all([...this.slots.values()].map((slot) => slot.service.stop()));

    this.rootPath = null;
    this.startOptions = undefined;
    this.configured = false;
  }

  /**
   * Check auto-shutdown (internal method)
   * Called when reference count for a file type reaches zero
   */
  private scheduleAutoShutdown(serviceType: LSPServiceType): void {
    const slot = this.slot(serviceType);

    // Don't shutdown if there are still active files of this kind
    if (slot.activeFiles.size > 0) return;

    // No need to shutdown if the server isn't running
    if (!slot.service.isRunning()) return;

    logger.info(
      `[LSPManager] No active ${slot.fileKind} files, auto-shutdown ${slot.label} in ${AUTO_SHUTDOWN_TIMEOUT_MS / 1000}s`
    );

    slot.shutdownTimer = setTimeout(async () => {
      slot.shutdownTimer = null;
      // Re-check if still no active files
      if (slot.activeFiles.size === 0 && slot.service.isRunning()) {
        logger.info(`[LSPManager] Auto-shutdown ${slot.label}`);
        await slot.service.stop();
        this.emit('serviceStopped', { service: serviceType });
      }
    }, AUTO_SHUTDOWN_TIMEOUT_MS);
  }

  isAnyRunning(): boolean {
    return [...this.slots.values()].some((slot) => slot.service.isRunning());
  }

  isRunning(filePath?: string): boolean {
    if (!filePath) {
      return this.isAnyRunning();
    }
    const service = this.getServiceForFile(filePath);
    return service?.isRunning() ?? false;
  }

  isVirtualMode(): boolean {
    return [...this.slots.values()].some((slot) => slot.service.isVirtualMode());
  }

  isConfigured(): boolean {
    return this.configured;
  }

  getActiveFileStats(): { latex: number; typst: number; markdown: number } {
    return {
      latex: this.slot('texlab').activeFiles.size,
      typst: this.slot('tinymist').activeFiles.size,
      markdown: this.slot('marksman').activeFiles.size,
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
    const slot = this.slotForFile(filePath);
    if (!slot) return;

    this.cancelShutdownTimer(slot);
    slot.activeFiles.add(filePath);
    logger.info(
      `[LSPManager] Tracking ${slot.fileKind} file: ${filePath} (active: ${slot.activeFiles.size})`
    );
  }

  private trackFileClosed(filePath: string): void {
    const slot = this.slotForFile(filePath);
    if (!slot) return;

    slot.activeFiles.delete(filePath);
    logger.info(
      `[LSPManager] Closed ${slot.fileKind} file: ${filePath} (active: ${slot.activeFiles.size})`
    );

    // Schedule auto-shutdown if no active files left
    if (slot.activeFiles.size === 0) {
      this.scheduleAutoShutdown(slot.key);
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

  async getSemanticTokens(filePath: string): Promise<{
    resultId?: string | null;
    data: number[];
    legend: { tokenTypes: string[]; tokenModifiers: string[] };
  } | null> {
    const service = await this.ensureServiceForFile(filePath);
    if (!service) return null;

    const result = await service.getSemanticTokens(filePath);
    if (!result) return null;

    if (
      this.slot('marksman')
        .service.getSupportedExtensions()
        .includes(this.getFileExtension(filePath))
    ) {
      return {
        ...result,
        legend: { tokenTypes: ['class', 'class', 'enumMember'], tokenModifiers: [] },
      };
    }

    return result;
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

  getMarkmanService(): MarkmanService {
    return this.slot('marksman').service as MarkmanService;
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
