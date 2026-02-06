/**
 * SciPen Studio - LSP UtilityProcess
 *
 * Runs LSP services in a separate process, achieving:
 * - Zero blocking of main process: all LSP communication happens in this process
 * - MessagePort direct connection: renderer process can communicate directly with this process, bypassing main process
 * - Process isolation: LSP crashes don't affect main process
 *
 * Communication protocol:
 * - Main process → LSP process: receive requests via process.on('message')
 * - LSP process → Main process: send responses/events via process.parentPort.postMessage()
 * - Renderer process → LSP process: direct connection via MessagePort (optional)
 */

import type { MessagePortMain } from 'electron';

// ============ Type Definitions ============

interface LSPRequest {
  id: string;
  type: 'request' | 'notification';
  method: string;
  params: unknown;
}

interface LSPResponse {
  id: string;
  type: 'response' | 'event';
  method?: string;
  result?: unknown;
  error?: { code: number; message: string };
}

interface LSPEvent {
  type: 'event';
  event: string;
  data: unknown;
}

// LSP Manager type (redefining interface here to avoid circular dependency from main process)
interface ILSPManager {
  start(
    rootPath: string,
    options?: { virtual?: boolean }
  ): Promise<{ texlab: boolean; tinymist: boolean }>;
  stop(): Promise<void>;
  isRunning(filePath?: string): boolean;
  isVirtualMode(): boolean;
  checkAvailability(): Promise<{
    texlab: boolean;
    tinymist: boolean;
    texlabVersion: string | null;
    tinymistVersion: string | null;
  }>;
  openDocument(filePath: string, content: string, languageId?: string): Promise<void>;
  updateDocument(filePath: string, content: string): Promise<void>;
  updateDocumentIncremental(filePath: string, changes: unknown[]): Promise<void>;
  closeDocument(filePath: string): Promise<void>;
  saveDocument(filePath: string): Promise<void>;
  getCompletions(filePath: string, line: number, character: number): Promise<unknown[]>;
  getHover(filePath: string, line: number, character: number): Promise<unknown>;
  getDefinition(filePath: string, line: number, character: number): Promise<unknown>;
  getReferences(
    filePath: string,
    line: number,
    character: number,
    includeDeclaration?: boolean
  ): Promise<unknown[]>;
  getDocumentSymbols(filePath: string): Promise<unknown[]>;
  build(filePath: string): Promise<{ status: string }>;
  forwardSearch(filePath: string, line: number): Promise<{ status: string }>;
  exportTypstPdf(filePath: string): Promise<{ success: boolean; pdfPath?: string; error?: string }>;
  formatTypstDocument(filePath: string): Promise<{ edits: unknown[] }>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
}

// Type declaration: Electron UtilityProcess parentPort
declare const process: NodeJS.Process & {
  parentPort: {
    postMessage(message: unknown): void;
    on(
      event: 'message',
      listener: (messageEvent: { data: unknown; ports: MessagePortMain[] }) => void
    ): void;
    on(event: 'close', listener: () => void): void;
  };
};

// ============ LSP Process Main Class ============

class LSPProcess {
  private lspManager: ILSPManager | null = null;
  private rendererPort: MessagePortMain | null = null;
  private pendingInit: Promise<void> | null = null;

  constructor() {
    this.setupParentPortHandlers();
    // Note: In UtilityProcess, console.info is used for debug output
    // eslint-disable-next-line no-console
    console.info('[LSP Process] Started');
  }

  /**
   * Setup communication with main process
   */
  private setupParentPortHandlers(): void {
    process.parentPort.on('message', async (messageEvent) => {
      const message = messageEvent.data as LSPRequest | { type: 'port' };
      const ports = messageEvent.ports;

      // Handle MessagePort transfer (for renderer process direct connection)
      if (message.type === 'port' && ports.length > 0) {
        this.setupRendererPort(ports[0]);
        return;
      }

      // Handle normal requests
      await this.handleRequest(message as LSPRequest, null);
    });

    process.parentPort.on('close', () => {
      // eslint-disable-next-line no-console
      console.info('[LSP Process] Main process connection closed, exiting...');
      this.cleanup();
      process.exit(0);
    });
  }

  /**
   * Setup direct connection with renderer process
   */
  private setupRendererPort(port: MessagePortMain): void {
    this.rendererPort = port;

    port.on('message', async (messageEvent) => {
      const message = messageEvent.data as LSPRequest;
      await this.handleRequest(message, port);
    });

    port.on('close', () => {
      // eslint-disable-next-line no-console
      console.info('[LSP Process] Renderer process connection closed');
      this.rendererPort = null;

      // Notify main process to forward to renderer, indicating need to rebuild direct connection
      this.broadcastEvent('directChannelClosed', {});
    });

    // Start receiving messages
    port.start();

    // eslint-disable-next-line no-console
    console.info('[LSP Process] Renderer process direct connection established');
  }

  /**
   * Handle request
   */
  private async handleRequest(
    request: LSPRequest,
    replyPort: MessagePortMain | null
  ): Promise<void> {
    const { id, method, params } = request;

    try {
      const result = await this.dispatch(method, params);
      this.sendResponse({ id, type: 'response', result }, replyPort);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.sendResponse(
        {
          id,
          type: 'response',
          error: { code: -1, message: errorMessage },
        },
        replyPort
      );
    }
  }

  /**
   * Dispatch request to specific method
   */
  private async dispatch(method: string, params: unknown): Promise<unknown> {
    // Special handling for initialization request
    if (method === 'initialize') {
      return this.initialize();
    }

    // Ensure initialized
    if (!this.lspManager) {
      if (this.pendingInit) {
        await this.pendingInit;
      } else {
        throw new Error('LSP Manager not initialized');
      }
    }

    const manager = this.lspManager!;
    const p = params as Record<string, unknown>;

    // Route to specific method
    switch (method) {
      // Lifecycle
      case 'start':
        return manager.start(p.rootPath as string, p.options as { virtual?: boolean });
      case 'stop':
        return manager.stop();
      case 'isRunning':
        return manager.isRunning(p.filePath as string | undefined);
      case 'isVirtualMode':
        return manager.isVirtualMode();
      case 'checkAvailability':
        return manager.checkAvailability();

      // Document operations
      case 'openDocument':
        return manager.openDocument(
          p.filePath as string,
          p.content as string,
          p.languageId as string | undefined
        );
      case 'updateDocument':
        return manager.updateDocument(p.filePath as string, p.content as string);
      case 'updateDocumentIncremental':
        return manager.updateDocumentIncremental(p.filePath as string, p.changes as unknown[]);
      case 'closeDocument':
        return manager.closeDocument(p.filePath as string);
      case 'saveDocument':
        return manager.saveDocument(p.filePath as string);

      // Language features
      case 'getCompletions':
        return manager.getCompletions(
          p.filePath as string,
          p.line as number,
          p.character as number
        );
      case 'getHover':
        return manager.getHover(p.filePath as string, p.line as number, p.character as number);
      case 'getDefinition':
        return manager.getDefinition(p.filePath as string, p.line as number, p.character as number);
      case 'getReferences':
        return manager.getReferences(
          p.filePath as string,
          p.line as number,
          p.character as number,
          p.includeDeclaration as boolean | undefined
        );
      case 'getDocumentSymbols':
        return manager.getDocumentSymbols(p.filePath as string);

      // Special features
      case 'build':
        return manager.build(p.filePath as string);
      case 'forwardSearch':
        return manager.forwardSearch(p.filePath as string, p.line as number);
      case 'exportTypstPdf':
        return manager.exportTypstPdf(p.filePath as string);
      case 'formatTypstDocument':
        return manager.formatTypstDocument(p.filePath as string);

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  /**
   * Initialize LSP Manager
   */
  private async initialize(): Promise<boolean> {
    if (this.lspManager) {
      return true;
    }

    this.pendingInit = this.doInitialize();
    await this.pendingInit;
    this.pendingInit = null;
    return true;
  }

  private async doInitialize(): Promise<void> {
    // Dynamically import LSPManager (avoid executing at module load time)
    const { getLSPManager } = await import('../services/LSPManager');
    this.lspManager = getLSPManager();

    // Setup event forwarding
    this.setupEventForwarding();

    // eslint-disable-next-line no-console
    console.info('[LSP Process] LSPManager initialized');
  }

  /**
   * Setup event forwarding
   */
  private setupEventForwarding(): void {
    if (!this.lspManager) return;

    const events = [
      'diagnostics',
      'initialized',
      'exit',
      'error',
      'serviceStarted',
      'serviceStopped',
      'serviceRestarted', // Triggered after TexLab/Tinymist crashes and restarts separately
    ];

    for (const eventName of events) {
      this.lspManager.on(eventName, (data) => {
        this.broadcastEvent(eventName, data);
      });
    }
  }

  /**
   * Broadcast event to all connected ports
   */
  private broadcastEvent(event: string, data: unknown): void {
    const message: LSPEvent = { type: 'event', event, data };

    // Send to main process
    process.parentPort.postMessage(message);

    // Send to renderer process (if connected)
    if (this.rendererPort) {
      this.rendererPort.postMessage(message);
    }
  }

  /**
   * Send response
   */
  private sendResponse(response: LSPResponse, port: MessagePortMain | null): void {
    if (port) {
      port.postMessage(response);
    } else {
      process.parentPort.postMessage(response);
    }
  }

  /**
   * Cleanup resources
   */
  private async cleanup(): Promise<void> {
    if (this.rendererPort) {
      this.rendererPort.close();
      this.rendererPort = null;
    }

    if (this.lspManager) {
      await this.lspManager.stop();
      this.lspManager = null;
    }
  }
}

// Start LSP process
new LSPProcess();
