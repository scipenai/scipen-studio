/**
 * @file BaseLSPService - Abstract base class for LSP implementations
 * @description Encapsulates common LSP protocol communication logic
 * @depends Sequencer, fsCompat, lsp/interfaces
 *
 * Features:
 * - JSON-RPC message handling
 * - Process management (spawn/kill)
 * - Document synchronization (open/close/update)
 * - Language features (completion, hover, definition, references, symbols)
 */

import { type ChildProcess, execFile, spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';
import { Sequencer } from '../../../shared/utils/async';
import { createLogger } from './LoggerService';
import fs from './knowledge/utils/fsCompat';
import type {
  LSPPosition as ILSPPosition,
  LSPTextDocumentContentChangeEvent as ILSPTextDocumentContentChangeEvent,
  ILanguageServer,
  LSPServerCapabilities,
} from './lsp/interfaces';

const logger = createLogger('BaseLSPService');

// ====== Environment Detection ======

/**
 * Safely detect if running in packaged environment
 * Compatible with main process and UtilityProcess
 */
function isPackaged(): boolean {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

  // Method 1: Check if resourcesPath contains app.asar
  if (resourcesPath?.includes('app.asar')) {
    return true;
  }

  // Method 2: Try using electron app module
  try {
    // Dynamic import to avoid errors in UtilityProcess
    const { app } = require('electron');
    if (app && typeof app.isPackaged === 'boolean') {
      return app.isPackaged;
    }
  } catch {
    // Cannot access app in UtilityProcess
  }

  // Method 3: Check if process.resourcesPath exists (only after packaging)
  if (resourcesPath) {
    return true;
  }

  // Default to development environment
  return false;
}

/**
 * Safely get application path
 * Compatible with main process and UtilityProcess
 */
function getAppPath(): string {
  try {
    const { app } = require('electron');
    if (app && typeof app.getAppPath === 'function') {
      return app.getAppPath();
    }
  } catch {
    // Cannot access in UtilityProcess
  }

  // Fallback: infer from __dirname
  // In development, __dirname is typically out/main/services
  return path.resolve(__dirname, '../../..');
}

// ====== LSP Type Definitions ======

export interface LSPPosition {
  line: number;
  character: number;
}

export interface LSPRange {
  start: LSPPosition;
  end: LSPPosition;
}

/**
 * LSP TextDocumentContentChangeEvent
 * Used for incremental document change synchronization
 */
export interface LSPTextDocumentContentChangeEvent {
  /** Range of the change (if empty, represents full update) */
  range?: LSPRange;
  /** Length of replaced text */
  rangeLength?: number;
  /** New text */
  text: string;
}

export interface LSPLocation {
  uri: string;
  range: LSPRange;
}

export interface LSPDiagnostic {
  range: LSPRange;
  severity?: 1 | 2 | 3 | 4; // Error, Warning, Information, Hint
  code?: string | number;
  source?: string;
  message: string;
  relatedInformation?: Array<{
    location: LSPLocation;
    message: string;
  }>;
}

export interface LSPCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { kind: string; value: string };
  insertText?: string;
  insertTextFormat?: 1 | 2; // PlainText, Snippet
  textEdit?: {
    range: LSPRange;
    newText: string;
  };
  sortText?: string;
  filterText?: string;
}

export interface LSPHover {
  contents:
    | string
    | { kind: string; value: string }
    | Array<string | { kind: string; value: string }>;
  range?: LSPRange;
}

export interface LSPSymbol {
  name: string;
  kind: number;
  location: LSPLocation;
  containerName?: string;
}

export interface LSPDocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: LSPRange;
  selectionRange: LSPRange;
  children?: LSPDocumentSymbol[];
}

export interface LSPTextEdit {
  range: LSPRange;
  newText: string;
}

// ====== LSP Message Types ======

export interface LSPMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// ====== LSP Initialization Options ======

export interface LSPStartOptions {
  virtual?: boolean;
}

// ====== Base LSP Service Class ======

export abstract class BaseLSPService extends EventEmitter implements ILanguageServer {
  protected process: ChildProcess | null = null;
  protected messageId = 0;
  protected pendingRequests: Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      method: string;
    }
  > = new Map();
  protected rawBuffer: Buffer = Buffer.alloc(0);
  protected contentLength = -1;
  protected initialized = false;
  protected executablePath: string | null = null;
  protected openDocuments: Map<string, { version: number; content: string }> = new Map();

  /**
   * Message sending sequencer
   * Ensures messages to LSP server are sent strictly in order,
   * preventing document state inconsistency from out-of-order didChange during fast typing.
   */
  protected messageSequencer = new Sequencer();

  // Virtual document mode: for remote projects, content passed directly via LSP
  protected virtualMode = false;
  protected virtualRootUri: string | null = null;

  // ====== ILanguageServer Abstract Properties (subclasses must implement) ======

  /** @example 'texlab', 'tinymist' */
  abstract readonly id: string;

  /** @example 'TexLab', 'Tinymist' */
  abstract readonly name: string;

  /** @example ['latex', 'bibtex'], ['typst'] */
  abstract readonly languageIds: string[];

  /** Include leading dot: ['.tex', '.bib'], ['.typ'] */
  abstract readonly extensions: string[];

  abstract readonly capabilities: LSPServerCapabilities;

  // ====== Other Abstract Methods (subclasses must implement) ======

  /** @deprecated Use `name` property instead */
  abstract getServiceName(): string;

  /** @deprecated Use `languageIds[0]` instead */
  abstract getDefaultLanguageId(): string;

  /** @deprecated Use `extensions` property instead */
  abstract getSupportedExtensions(): string[];

  protected abstract findExecutable(): Promise<string | null>;
  protected abstract getVersionRegex(): RegExp;
  protected abstract getInitializeCapabilities(): object;

  // ====== Public Methods ======

  async isAvailable(): Promise<boolean> {
    const execPath = await this.findExecutable();
    return execPath !== null;
  }

  async getVersion(): Promise<string | null> {
    const execPath = await this.findExecutable();
    if (!execPath) return null;

    return new Promise((resolve) => {
      execFile(execPath, ['--version'], { timeout: 5000 }, (error, stdout) => {
        if (error) {
          resolve(null);
        } else {
          const match = stdout.match(this.getVersionRegex());
          resolve(match ? match[1] : stdout.trim());
        }
      });
    });
  }

  async start(rootPath: string, options?: LSPStartOptions): Promise<boolean> {
    if (this.process) {
      return true;
    }

    const execPath = await this.findExecutable();
    if (!execPath) {
      console.error(`[${this.getServiceName()}] Executable not found`);
      return false;
    }

    // Set virtual mode
    this.virtualMode = options?.virtual ?? false;

    if (this.virtualMode) {
      this.virtualRootUri = `virtual:///${rootPath.replace(/\\/g, '/')}`;
    }

    try {
      this.process = spawn(execPath, this.getSpawnArgs(), {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, RUST_BACKTRACE: '1' },
        // Windows: Hide console window to prevent flash
        windowsHide: true,
      });

      this.process.stdout?.on('data', (data: Buffer) => {
        this.handleData(data);
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        console.error(`[${this.getServiceName()} stderr]`, data.toString());
      });

      this.process.on('error', (error) => {
        console.error(`[${this.getServiceName()}] Process error:`, error);
        this.emit('error', error);
      });

      this.process.on('exit', (code, signal) => {
        this.process = null;
        this.initialized = false;
        this.virtualMode = false;
        this.virtualRootUri = null;
        this.emit('exit', { code, signal });
      });

      // Initialize LSP
      await this.initialize(rootPath);
      return true;
    } catch (error) {
      console.error(`[${this.getServiceName()}] Failed to start:`, error);
      return false;
    }
  }

  /** Subclasses can override to add arguments */
  protected getSpawnArgs(): string[] {
    return [];
  }

  async stop(): Promise<void> {
    if (!this.process) return;

    try {
      await this.sendRequest('shutdown', null);
      this.sendNotification('exit', null);
    } catch {
      // Ignore errors during shutdown
    }

    this.process.kill();
    this.process = null;
    this.initialized = false;
    this.virtualMode = false;
    this.virtualRootUri = null;
    this.openDocuments.clear();
    this.pendingRequests.clear();
  }

  isVirtualMode(): boolean {
    return this.virtualMode;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  isRunning(): boolean {
    return this.process !== null;
  }

  // ====== Document Operations ======

  async openDocument(filePath: string, content: string, languageId?: string): Promise<void> {
    if (!this.initialized) return;

    const uri = this.pathToUri(filePath);
    const version = 1;
    const lang = languageId || this.getDefaultLanguageId();

    this.openDocuments.set(uri, { version, content });

    this.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: lang,
        version,
        text: content,
      },
    });
  }

  /** Full content replacement */
  async updateDocument(filePath: string, content: string): Promise<void> {
    if (!this.initialized) return;

    const uri = this.pathToUri(filePath);
    const doc = this.openDocuments.get(uri);

    if (!doc) {
      await this.openDocument(filePath, content);
      return;
    }

    const version = doc.version + 1;
    this.openDocuments.set(uri, { version, content });

    this.sendNotification('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text: content }],
    });
  }

  /** Sends only changed portions, reducing data transfer for large files */
  async updateDocumentIncremental(
    filePath: string,
    changes: LSPTextDocumentContentChangeEvent[]
  ): Promise<void> {
    if (!this.initialized) return;

    const uri = this.pathToUri(filePath);
    const doc = this.openDocuments.get(uri);

    if (!doc) {
      // Document not open, need to open first (can only use first change text as initial content)
      // This is a fallback scenario, normally document should already be open
      console.warn(
        `[${this.getServiceName()}] Incremental update for unopened document: ${filePath}`
      );
      if (changes.length > 0 && !changes[0].range) {
        // If first change is a full change, use it to open the document
        await this.openDocument(filePath, changes[0].text);
      }
      return;
    }

    const version = doc.version + 1;

    // Note: We no longer try to maintain document content mirror in main process
    // In incremental mode it's hard to ensure consistency, and LSP server maintains its own
    // Only update version number
    this.openDocuments.set(uri, { version, content: doc.content });

    // Send incremental changes to LSP server
    this.sendNotification('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: changes,
    });
  }

  async closeDocument(filePath: string): Promise<void> {
    if (!this.initialized) return;

    const uri = this.pathToUri(filePath);
    this.openDocuments.delete(uri);

    this.sendNotification('textDocument/didClose', {
      textDocument: { uri },
    });
  }

  /**
   * Omits text field since main process doesn't mirror content in incremental mode.
   * LSP server uses its own state maintained via didChange.
   */
  async saveDocument(filePath: string): Promise<void> {
    if (!this.initialized) return;

    const uri = this.pathToUri(filePath);

    // Don't send text field to avoid sending stale content
    // LSP server uses its own latest content maintained via didChange
    this.sendNotification('textDocument/didSave', {
      textDocument: { uri },
    });
  }

  // ====== Language Features ======

  async getCompletions(filePath: string, position: ILSPPosition): Promise<LSPCompletionItem[]> {
    if (!this.initialized) {
      logger.info(`[${this.getServiceName()}] Completion request ignored: service not initialized`);
      return [];
    }

    const { line, character } = position;
    const uri = this.pathToUri(filePath);

    try {
      const result = (await this.sendRequest('textDocument/completion', {
        textDocument: { uri },
        position: { line, character },
        context: { triggerKind: 1 },
      })) as { items?: LSPCompletionItem[] } | LSPCompletionItem[] | null;

      if (!result) return [];
      if (Array.isArray(result)) return result;
      return result.items || [];
    } catch (error) {
      console.error(`[${this.getServiceName()}] Completion error:`, error);
      return [];
    }
  }

  async getHover(filePath: string, position: ILSPPosition): Promise<LSPHover | null> {
    if (!this.initialized) return null;

    const { line, character } = position;
    try {
      const result = (await this.sendRequest('textDocument/hover', {
        textDocument: { uri: this.pathToUri(filePath) },
        position: { line, character },
      })) as LSPHover | null;

      return result;
    } catch (error) {
      console.error(`[${this.getServiceName()}] Hover error:`, error);
      return null;
    }
  }

  async getDefinition(
    filePath: string,
    position: ILSPPosition
  ): Promise<LSPLocation | LSPLocation[] | null> {
    if (!this.initialized) return null;

    const { line, character } = position;
    try {
      const result = (await this.sendRequest('textDocument/definition', {
        textDocument: { uri: this.pathToUri(filePath) },
        position: { line, character },
      })) as LSPLocation | LSPLocation[] | null;

      return result;
    } catch (error) {
      console.error(`[${this.getServiceName()}] Definition error:`, error);
      return null;
    }
  }

  async getReferences(
    filePath: string,
    position: ILSPPosition,
    includeDeclaration = true
  ): Promise<LSPLocation[]> {
    if (!this.initialized) return [];

    const { line, character } = position;
    try {
      const result = (await this.sendRequest('textDocument/references', {
        textDocument: { uri: this.pathToUri(filePath) },
        position: { line, character },
        context: { includeDeclaration },
      })) as LSPLocation[] | null;

      return result || [];
    } catch (error) {
      console.error(`[${this.getServiceName()}] References error:`, error);
      return [];
    }
  }

  async getDocumentSymbols(filePath: string): Promise<LSPDocumentSymbol[] | LSPSymbol[]> {
    if (!this.initialized) return [];

    try {
      const result = (await this.sendRequest('textDocument/documentSymbol', {
        textDocument: { uri: this.pathToUri(filePath) },
      })) as LSPDocumentSymbol[] | LSPSymbol[] | null;

      return result || [];
    } catch (error) {
      console.error(`[${this.getServiceName()}] Document symbols error:`, error);
      return [];
    }
  }

  // ====== LSP Initialization ======

  protected async initialize(rootPath: string): Promise<void> {
    const rootUri = this.virtualMode ? this.virtualRootUri! : this.pathToUri(rootPath);

    await this.sendRequest('initialize', {
      processId: process.pid,
      rootUri: rootUri,
      rootPath: rootPath,
      capabilities: this.getInitializeCapabilities(),
      workspaceFolders: [
        {
          uri: rootUri,
          name: path.basename(rootPath),
        },
      ],
    });

    this.sendNotification('initialized', {});
    this.initialized = true;
    this.emit('initialized');
  }

  // ====== LSP Communication Methods ======

  protected sendRequest(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin) {
        reject(new Error('LSP process not running'));
        return;
      }

      const id = ++this.messageId;
      this.pendingRequests.set(id, { resolve, reject, method });

      const message: LSPMessage = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      this.sendMessage(message);

      // Timeout handling
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, 30000);
    });
  }

  protected sendNotification(method: string, params: unknown): void {
    if (!this.process?.stdin) return;

    const message: LSPMessage = {
      jsonrpc: '2.0',
      method,
      params,
    };

    this.sendMessage(message);
  }

  /** Uses Sequencer to ensure order and handle stdin backpressure */
  protected sendMessage(message: LSPMessage): void {
    // Queue in Sequencer
    this.messageSequencer.queue(async () => {
      const content = JSON.stringify(message);
      const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`;
      const data = header + content;

      if (this.process?.stdin?.writable) {
        const canContinue = this.process.stdin.write(data);

        // If write returns false, internal buffer is full, need to wait for drain event
        if (!canContinue) {
          await new Promise<void>((resolve) => {
            this.process?.stdin?.once('drain', resolve);
          });
        }
      }
    });
  }

  protected handleData(data: Buffer): void {
    this.rawBuffer = Buffer.concat([this.rawBuffer, data]);

    while (true) {
      if (this.contentLength === -1) {
        const headerEndStr = '\r\n\r\n';
        const headerEndIndex = this.rawBuffer.indexOf(headerEndStr);
        if (headerEndIndex === -1) break;

        const headerStr = this.rawBuffer.slice(0, headerEndIndex).toString('utf8');
        const match = headerStr.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          console.error(`[${this.getServiceName()}] Invalid header:`, headerStr);
          this.rawBuffer = this.rawBuffer.slice(headerEndIndex + 4);
          continue;
        }

        this.contentLength = Number.parseInt(match[1], 10);
        this.rawBuffer = this.rawBuffer.slice(headerEndIndex + 4);
      }

      if (this.rawBuffer.length < this.contentLength) break;

      const content = this.rawBuffer.slice(0, this.contentLength).toString('utf8');
      this.rawBuffer = this.rawBuffer.slice(this.contentLength);
      this.contentLength = -1;

      try {
        const message = JSON.parse(content) as LSPMessage;
        this.handleMessage(message);
      } catch (error) {
        console.error(`[${this.getServiceName()}] Failed to parse message:`, error);
      }
    }
  }

  protected handleMessage(message: LSPMessage): void {
    // Response message
    if (message.id !== undefined && !message.method) {
      const pending = this.pendingRequests.get(message.id as number);
      if (pending) {
        this.pendingRequests.delete(message.id as number);
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }

    // Notification message
    if (message.method) {
      this.handleNotification(message.method, message.params);
    }
  }

  /** Subclasses can override to handle additional notification types */
  protected handleNotification(method: string, params: unknown): void {
    switch (method) {
      case 'textDocument/publishDiagnostics': {
        const { uri, diagnostics } = params as { uri: string; diagnostics: LSPDiagnostic[] };
        this.emit('diagnostics', {
          filePath: this.uriToPath(uri),
          diagnostics,
        });
        break;
      }
      case 'window/logMessage': {
        // LSP log message
        break;
      }
      case 'window/showMessage': {
        const { type, message } = params as { type: number; message: string };
        this.emit('message', { type, message });
        break;
      }
      default:
        // Ignore other notifications
        break;
    }
  }

  // ====== Utility Methods ======

  /**
   * Convert file path to URI
   *
   * Handles multiple path formats:
   * - Local path: C:\foo\bar.tex → file:///C:/foo/bar.tex
   * - Virtual path: virtual://... → unchanged
   * - Overleaf path (virtualMode=true): overleaf://xxx → virtual:///overleaf://xxx
   *
   * Important: TexLab only recognizes file:// and virtual:// schemes, not overleaf://
   * So Overleaf paths must be converted to virtual:// scheme in virtualMode
   */
  protected pathToUri(filePath: string): string {
    // Normalize backslashes to forward slashes
    const normalized = filePath.replace(/\\/g, '/');

    // Already a virtual:// URI, return as-is
    if (normalized.startsWith('virtual://')) {
      return normalized;
    }

    // Virtual mode (for Overleaf and other remote projects)
    // All paths converted to virtual:// scheme, letting TexLab handle in memory
    if (this.virtualMode) {
      return `virtual:///${normalized}`;
    }

    // Local mode: use file:// scheme
    if (process.platform === 'win32') {
      return `file:///${normalized}`;
    }
    return `file://${normalized}`;
  }

  /**
   * Convert URI to file path
   *
   * Reverse conversion:
   * - virtual:///overleaf://xxx → overleaf://xxx
   * - virtual:///path → path
   * - file:///path → path
   */
  protected uriToPath(uri: string): string {
    // Handle virtual:// scheme
    if (uri.startsWith('virtual://')) {
      // Remove virtual:/// prefix, preserve original path
      // virtual:///overleaf://xxx → overleaf://xxx
      // virtual:///C:/path → C:/path
      return uri.replace(/^virtual:\/\/\/?/, '');
    }

    // Handle file:// scheme
    let filePath = uri.replace(/^file:\/\/\/?/, '');
    if (process.platform === 'win32' && filePath.startsWith('/')) {
      filePath = filePath.slice(1);
    }
    return filePath.replace(/\//g, path.sep);
  }

  protected async findExecutableInCandidates(
    candidates: string[],
    binName: string
  ): Promise<string | null> {
    for (const candidate of candidates) {
      try {
        if (candidate === binName) {
          // Check if exists in PATH
          const result = await new Promise<boolean>((resolve) => {
            execFile(candidate, ['--version'], { timeout: 5000 }, (error) => {
              resolve(!error);
            });
          });
          if (result) {
            this.executablePath = candidate;
            return candidate;
          }
        } else if (await fs.pathExists(candidate)) {
          this.executablePath = candidate;
          return candidate;
        }
      } catch {
        // Continue to next candidate
      }
    }

    return null;
  }

  protected getAppBinPath(): string {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (isPackaged() && resourcesPath) {
      return path.join(resourcesPath, 'bin');
    }
    return path.join(getAppPath(), 'resources', 'bin');
  }

  // ============ ILanguageServer Interface Methods ============

  getPid(): number | null {
    return this.process?.pid ?? null;
  }

  async updateDocumentIncrementalI(
    uri: string,
    changes: ILSPTextDocumentContentChangeEvent[]
  ): Promise<void> {
    // Convert ILanguageServer format to internal format
    const internalChanges: LSPTextDocumentContentChangeEvent[] = changes.map((change) => ({
      range: change.range,
      rangeLength: change.rangeLength,
      text: change.text,
    }));
    await this.updateDocumentIncremental(uri, internalChanges);
  }

  async formatDocument(filePath: string): Promise<LSPTextEdit[]> {
    if (!this.initialized) {
      return [];
    }

    const uri = this.pathToUri(filePath);

    try {
      const result = (await this.sendRequest('textDocument/formatting', {
        textDocument: { uri },
        options: {
          tabSize: 2,
          insertSpaces: true,
        },
      })) as LSPTextEdit[] | null;

      return result || [];
    } catch (error) {
      console.error(`[${this.getServiceName()}] Format document error:`, error);
      return [];
    }
  }

  // ============ ILanguageServer Position-based Adapters ============

  async getCompletionsAt(uri: string, position: ILSPPosition): Promise<LSPCompletionItem[]> {
    return this.getCompletions(uri, position);
  }

  async getHoverAt(uri: string, position: ILSPPosition): Promise<LSPHover | null> {
    return this.getHover(uri, position);
  }

  async getDefinitionAt(
    uri: string,
    position: ILSPPosition
  ): Promise<LSPLocation | LSPLocation[] | null> {
    return this.getDefinition(uri, position);
  }

  async getReferencesAt(
    uri: string,
    position: ILSPPosition,
    includeDeclaration?: boolean
  ): Promise<LSPLocation[]> {
    return this.getReferences(uri, position, includeDeclaration);
  }
}
