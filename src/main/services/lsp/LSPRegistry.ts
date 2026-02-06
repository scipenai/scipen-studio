/**
 * @file LSPRegistry - Language server registry center
 * @description Central management for all language server instances
 * @depends ILanguageServer, EventEmitter
 *
 * Features:
 * - Find servers by language ID or file extension
 * - Dynamic register/unregister servers
 * - Priority handling (when multiple servers for same file type)
 * - Lifecycle management (start/stop all servers)
 * - **Lazy instantiation**: servers created only on first use
 *
 * Design patterns: Registry Pattern + Singleton + Lazy Factory
 */

import { EventEmitter } from 'events';
import { createLogger } from '../LoggerService';
import type {
  ILanguageServer,
  ILanguageServerConstructor,
  LSPStartOptions,
  LanguageServerRegistration,
} from './interfaces';

const logger = createLogger('LSPRegistry');

/**
 * Registry entry (internal use)
 * Supports lazy loading: factory stores constructor, instance created on demand
 */
interface RegistryEntry {
  id: string;
  /** Constructor (for lazy instantiation) */
  factory?: ILanguageServerConstructor;
  /** Instance (lazily created or directly registered) */
  instance?: ILanguageServer;
  enabled: boolean;
  priority: number;
  /** Cached language ID list (for indexing, avoids instantiation) */
  languageIds: Set<string>;
  /** Cached extension list (for indexing, avoids instantiation) */
  extensions: Set<string>;
}

/**
 * LSP Registry events
 */
export interface LSPRegistryEvents {
  /** Server registered */
  registered: { id: string; server?: ILanguageServer };
  /** Server unregistered */
  unregistered: { id: string };
  /** Server started */
  started: { id: string };
  /** Server stopped */
  stopped: { id: string };
  /** Server instantiated (lazy load) */
  instantiated: { id: string; server: ILanguageServer };
  /** Error */
  error: { id: string; error: Error };
}

/**
 * LSP Registry
 */
class LSPRegistryImpl extends EventEmitter {
  private entries: Map<string, RegistryEntry> = new Map();
  private languageIdIndex: Map<string, Set<string>> = new Map();
  private extensionIndex: Map<string, Set<string>> = new Map();

  /**
   * Register language server
   *
   * Supports two modes:
   * 1. Pass instance: immediately available
   * 2. Pass constructor + metadata: lazy load, instantiate on first access
   *
   * @param registration Registration info
   * @throws If ID already exists
   */
  register(registration: LanguageServerRegistration): void {
    const { id, server, enabled = true, priority = 0, languageIds, extensions } = registration;

    if (this.entries.has(id)) {
      throw new Error(`LSP server "${id}" already registered`);
    }

    const isConstructor = typeof server === 'function';

    // Determine if lazy loading is possible
    // Condition: constructor passed + languageIds and extensions metadata provided
    const canLazyLoad = isConstructor && languageIds && extensions;

    let entry: RegistryEntry;

    if (canLazyLoad) {
      // Lazy load mode: don't instantiate immediately
      entry = {
        id,
        factory: server as ILanguageServerConstructor,
        instance: undefined,
        enabled,
        priority,
        languageIds: new Set(languageIds),
        extensions: new Set(extensions.map((ext) => (ext.startsWith('.') ? ext : `.${ext}`))),
      };
      logger.info(`[LSP Registry] Registered (lazy): ${id} (${languageIds.join(', ')})`);
    } else {
      // Immediate instantiation mode
      const instance: ILanguageServer = isConstructor
        ? new (server as ILanguageServerConstructor)()
        : server;

      entry = {
        id,
        factory: isConstructor ? (server as ILanguageServerConstructor) : undefined,
        instance,
        enabled,
        priority,
        languageIds: new Set(instance.languageIds),
        extensions: new Set(
          instance.extensions.map((ext) => (ext.startsWith('.') ? ext : `.${ext}`))
        ),
      };
      logger.info(`[LSP Registry] Registered: ${id} (${instance.languageIds.join(', ')})`);
    }

    // Add to main index
    this.entries.set(id, entry);

    // Build language ID index
    for (const langId of entry.languageIds) {
      if (!this.languageIdIndex.has(langId)) {
        this.languageIdIndex.set(langId, new Set());
      }
      this.languageIdIndex.get(langId)!.add(id);
    }

    // Build extension index
    for (const ext of entry.extensions) {
      if (!this.extensionIndex.has(ext)) {
        this.extensionIndex.set(ext, new Set());
      }
      this.extensionIndex.get(ext)!.add(id);
    }

    this.emit('registered', { id, server: entry.instance });
  }

  /**
   * Unregister language server
   *
   * @param id Server ID
   * @returns Whether unregistration was successful
   */
  async unregister(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) {
      return false;
    }

    // Stop server (if instantiated and running)
    if (entry.instance?.isRunning()) {
      await entry.instance.stop();
    }

    // Remove from indexes
    for (const langId of entry.languageIds) {
      this.languageIdIndex.get(langId)?.delete(id);
    }
    for (const ext of entry.extensions) {
      this.extensionIndex.get(ext)?.delete(id);
    }

    this.entries.delete(id);
    this.emit('unregistered', { id });
    logger.info(`[LSP Registry] Unregistered: ${id}`);
    return true;
  }

  /**
   * Get server by ID (triggers lazy instantiation)
   */
  get(id: string): ILanguageServer | undefined {
    const entry = this.entries.get(id);
    if (!entry) {
      return undefined;
    }
    return this.ensureInstance(entry);
  }

  /**
   * Get server by language ID
   *
   * @param languageId Language identifier (e.g., 'latex', 'typst')
   * @returns Matching server (first by priority) or undefined
   */
  getByLanguageId(languageId: string): ILanguageServer | undefined {
    const serverIds = this.languageIdIndex.get(languageId);
    if (!serverIds || serverIds.size === 0) {
      return undefined;
    }

    return this.getHighestPriority(serverIds);
  }

  /**
   * Get server by file extension
   *
   * @param extension File extension (e.g., '.tex', '.typ')
   * @returns Matching server or undefined
   */
  getByExtension(extension: string): ILanguageServer | undefined {
    const normalizedExt = extension.startsWith('.') ? extension : `.${extension}`;
    const serverIds = this.extensionIndex.get(normalizedExt);
    if (!serverIds || serverIds.size === 0) {
      return undefined;
    }

    return this.getHighestPriority(serverIds);
  }

  /**
   * Get server by file path
   *
   * @param filePath File path
   * @returns Matching server or undefined
   */
  getByFilePath(filePath: string): ILanguageServer | undefined {
    const ext = this.extractExtension(filePath);
    if (!ext) {
      return undefined;
    }
    return this.getByExtension(ext);
  }

  /**
   * Get all registered servers (triggers all lazy instantiation)
   */
  getAll(): ILanguageServer[] {
    return Array.from(this.entries.values())
      .map((e) => this.ensureInstance(e))
      .filter((s): s is ILanguageServer => s !== undefined);
  }

  /**
   * Get all enabled servers (triggers lazy instantiation)
   */
  getEnabled(): ILanguageServer[] {
    return Array.from(this.entries.values())
      .filter((e) => e.enabled)
      .map((e) => this.ensureInstance(e))
      .filter((s): s is ILanguageServer => s !== undefined);
  }

  /**
   * Get all running servers (only checks instantiated ones)
   */
  getRunning(): ILanguageServer[] {
    return Array.from(this.entries.values())
      .filter((e) => e.instance?.isRunning())
      .map((e) => e.instance!)
      .filter((s): s is ILanguageServer => s !== undefined);
  }

  /**
   * Enable/disable server
   */
  setEnabled(id: string, enabled: boolean): boolean {
    const entry = this.entries.get(id);
    if (!entry) {
      return false;
    }
    entry.enabled = enabled;
    return true;
  }

  /**
   * Start all enabled servers (triggers lazy instantiation)
   */
  async startAll(rootPath: string, options?: LSPStartOptions): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};

    for (const entry of this.entries.values()) {
      if (!entry.enabled) {
        results[entry.id] = false;
        continue;
      }

      try {
        const server = this.ensureInstance(entry);
        if (!server) {
          console.error(`[LSP Registry] Cannot instantiate ${entry.id}`);
          results[entry.id] = false;
          continue;
        }

        const isAvailable = await server.isAvailable();
        if (!isAvailable) {
          logger.info(`[LSP Registry] ${entry.id} not available, skipping start`);
          results[entry.id] = false;
          continue;
        }

        const success = await server.start(rootPath, options);
        results[entry.id] = success;

        if (success) {
          this.emit('started', { id: entry.id });
          logger.info(`[LSP Registry] ${entry.id} started`);
        }
      } catch (error) {
        console.error(`[LSP Registry] Failed to start ${entry.id}:`, error);
        results[entry.id] = false;
        this.emit('error', { id: entry.id, error: error as Error });
      }
    }

    return results;
  }

  /**
   * Stop all servers (only instantiated ones)
   */
  async stopAll(): Promise<void> {
    const stopPromises = Array.from(this.entries.values())
      .filter((e) => e.instance)
      .map(async (entry) => {
        try {
          if (entry.instance!.isRunning()) {
            await entry.instance!.stop();
            this.emit('stopped', { id: entry.id });
            logger.info(`[LSP Registry] ${entry.id} stopped`);
          }
        } catch (error) {
          console.error(`[LSP Registry] Failed to stop ${entry.id}:`, error);
        }
      });

    await Promise.all(stopPromises);
  }

  /**
   * Check if any server is running
   */
  hasRunning(): boolean {
    return Array.from(this.entries.values()).some((e) => e.instance?.isRunning());
  }

  /**
   * Check if server is instantiated
   */
  isInstantiated(id: string): boolean {
    return this.entries.get(id)?.instance !== undefined;
  }

  /**
   * Get registry status summary
   */
  getStatus(): Record<
    string,
    {
      enabled: boolean;
      running: boolean;
      instantiated: boolean;
      languageIds: string[];
    }
  > {
    const status: Record<
      string,
      {
        enabled: boolean;
        running: boolean;
        instantiated: boolean;
        languageIds: string[];
      }
    > = {};

    for (const entry of this.entries.values()) {
      status[entry.id] = {
        enabled: entry.enabled,
        running: entry.instance?.isRunning() ?? false,
        instantiated: entry.instance !== undefined,
        languageIds: Array.from(entry.languageIds),
      };
    }

    return status;
  }

  /**
   * Clear registry
   */
  async clear(): Promise<void> {
    await this.stopAll();
    this.entries.clear();
    this.languageIdIndex.clear();
    this.extensionIndex.clear();
  }

  /**
   * Get all registered server IDs
   */
  getRegisteredIds(): string[] {
    return Array.from(this.entries.keys());
  }

  // ====== Private Methods ======

  /**
   * Ensure server instance exists (lazy instantiation)
   */
  private ensureInstance(entry: RegistryEntry): ILanguageServer | undefined {
    if (entry.instance) {
      return entry.instance;
    }

    if (entry.factory) {
      try {
        entry.instance = new entry.factory();
        logger.info(`[LSP Registry] Lazy instantiation: ${entry.id}`);
        this.emit('instantiated', { id: entry.id, server: entry.instance });
        return entry.instance;
      } catch (error) {
        console.error(`[LSP Registry] Failed to instantiate ${entry.id}:`, error);
        this.emit('error', { id: entry.id, error: error as Error });
        return undefined;
      }
    }

    return undefined;
  }

  /**
   * Get highest priority server from a set of server IDs (triggers lazy instantiation)
   */
  private getHighestPriority(serverIds: Set<string>): ILanguageServer | undefined {
    let highestPriority = Number.NEGATIVE_INFINITY;
    let resultEntry: RegistryEntry | undefined;

    for (const id of serverIds) {
      const entry = this.entries.get(id);
      if (entry?.enabled && entry.priority > highestPriority) {
        highestPriority = entry.priority;
        resultEntry = entry;
      }
    }

    if (!resultEntry) {
      return undefined;
    }

    return this.ensureInstance(resultEntry);
  }

  /**
   * Extract extension from file path
   */
  private extractExtension(filePath: string): string | null {
    const match = filePath.match(/\.[^./\\]+$/);
    return match ? match[0].toLowerCase() : null;
  }
}

// Export singleton
export const LSPRegistry = new LSPRegistryImpl();

// Export type (for testing or special scenarios)
export type { LSPRegistryImpl };
