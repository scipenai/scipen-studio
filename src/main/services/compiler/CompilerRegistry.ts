/**
 * @file CompilerRegistry - Compiler Registry
 * @description Unified compiler instance management with extension/engine lookup, dynamic registration, priority, lazy instantiation
 * @depends ICompiler, LoggerService
 */

import { EventEmitter } from 'events';
import { createLogger } from '../LoggerService';
import type { CompilerRegistration, ICompiler, ICompilerConstructor } from './interfaces';

const logger = createLogger('CompilerRegistry');

/**
 * Registry entry (internal use)
 * Supports lazy loading: factory stores constructor, instance created on demand
 */
interface RegistryEntry {
  id: string;
  /** Constructor (for lazy instantiation) */
  factory?: ICompilerConstructor;
  /** Instance (lazily created or directly registered) */
  instance?: ICompiler;
  enabled: boolean;
  priority: number;
  /** Cached extension list (for indexing, avoids instantiation) */
  extensions: Set<string>;
  /** Cached engine list (for indexing, avoids instantiation) */
  engines: Set<string>;
}

/**
 * Compiler Registry events
 */
export interface CompilerRegistryEvents {
  /** Compiler registered */
  registered: { id: string; compiler?: ICompiler };
  /** Compiler unregistered */
  unregistered: { id: string };
  /** Compiler instantiated (lazy loading) */
  instantiated: { id: string; compiler: ICompiler };
  /** Error */
  error: { id: string; error: Error };
}

/**
 * Compiler registry
 */
class CompilerRegistryImpl extends EventEmitter {
  private entries: Map<string, RegistryEntry> = new Map();
  private extensionIndex: Map<string, Set<string>> = new Map();
  private engineIndex: Map<string, Set<string>> = new Map();

  /**
   * Register compiler
   *
   * Supports two modes:
   * 1. Pass instance: immediately available
   * 2. Pass constructor + metadata: lazy loading, instantiated on first access
   *
   * @param registration Registration information
   * @throws If ID already exists
   */
  register(registration: CompilerRegistration): void {
    const { id, compiler, enabled = true, priority = 0, extensions, engines } = registration;

    if (this.entries.has(id)) {
      throw new Error(`Compiler "${id}" already registered`);
    }

    const isConstructor = typeof compiler === 'function';

    // Determine if lazy loading is possible
    // Condition: pass constructor + provide extensions and engines metadata
    const canLazyLoad = isConstructor && extensions && engines;

    let entry: RegistryEntry;

    if (canLazyLoad) {
      // Lazy loading mode: don't instantiate immediately
      entry = {
        id,
        factory: compiler as ICompilerConstructor,
        instance: undefined,
        enabled,
        priority,
        extensions: new Set(extensions.map((ext) => (ext.startsWith('.') ? ext : `.${ext}`))),
        engines: new Set(engines.map((e) => e.toLowerCase())),
      };
      logger.info(`[Compiler Registry] Registered (lazy): ${id} (${extensions.join(', ')})`);
    } else {
      // Immediate instantiation mode
      const instance: ICompiler = isConstructor
        ? new (compiler as ICompilerConstructor)()
        : compiler;

      entry = {
        id,
        factory: isConstructor ? (compiler as ICompilerConstructor) : undefined,
        instance,
        enabled,
        priority,
        extensions: new Set(
          instance.extensions.map((ext) => (ext.startsWith('.') ? ext : `.${ext}`))
        ),
        engines: new Set(instance.engines.map((e) => e.toLowerCase())),
      };
      logger.info(`[Compiler Registry] Registered: ${id} (${instance.extensions.join(', ')})`);
    }

    // Add to main index
    this.entries.set(id, entry);

    // Build extension index
    for (const ext of entry.extensions) {
      if (!this.extensionIndex.has(ext)) {
        this.extensionIndex.set(ext, new Set());
      }
      this.extensionIndex.get(ext)!.add(id);
    }

    // Build engine index
    for (const engine of entry.engines) {
      if (!this.engineIndex.has(engine)) {
        this.engineIndex.set(engine, new Set());
      }
      this.engineIndex.get(engine)!.add(id);
    }

    this.emit('registered', { id, compiler: entry.instance });
  }

  /**
   * Unregister compiler
   *
   * @param id Compiler ID
   * @returns Whether unregistration succeeded
   */
  unregister(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) {
      return false;
    }

    // Remove from indices
    for (const ext of entry.extensions) {
      this.extensionIndex.get(ext)?.delete(id);
    }
    for (const engine of entry.engines) {
      this.engineIndex.get(engine)?.delete(id);
    }

    this.entries.delete(id);
    this.emit('unregistered', { id });
    logger.info(`[Compiler Registry] Unregistered: ${id}`);
    return true;
  }

  /**
   * Get compiler by ID (triggers lazy instantiation)
   */
  get(id: string): ICompiler | undefined {
    const entry = this.entries.get(id);
    if (!entry) {
      return undefined;
    }
    return this.ensureInstance(entry);
  }

  /**
   * Get compiler by file extension
   *
   * @param extension File extension (e.g., '.tex', '.typ')
   * @returns Matching compiler or undefined
   */
  getByExtension(extension: string): ICompiler | undefined {
    const normalizedExt = extension.startsWith('.') ? extension : `.${extension}`;
    const compilerIds = this.extensionIndex.get(normalizedExt);
    if (!compilerIds || compilerIds.size === 0) {
      return undefined;
    }

    return this.getHighestPriority(compilerIds);
  }

  /**
   * Get compiler by engine name
   *
   * @param engine Engine name (e.g., 'xelatex', 'typst')
   * @returns Matching compiler or undefined
   */
  getByEngine(engine: string): ICompiler | undefined {
    const normalizedEngine = engine.toLowerCase();
    const compilerIds = this.engineIndex.get(normalizedEngine);
    if (!compilerIds || compilerIds.size === 0) {
      return undefined;
    }

    return this.getHighestPriority(compilerIds);
  }

  /**
   * Get compiler by file path
   *
   * @param filePath File path
   * @returns Matching compiler or undefined
   */
  getByFilePath(filePath: string): ICompiler | undefined {
    const ext = this.extractExtension(filePath);
    if (!ext) {
      return undefined;
    }
    return this.getByExtension(ext);
  }

  /**
   * Get all registered compilers (triggers all lazy instantiations)
   */
  getAll(): ICompiler[] {
    return Array.from(this.entries.values())
      .map((e) => this.ensureInstance(e))
      .filter((c): c is ICompiler => c !== undefined);
  }

  /**
   * Get all enabled compilers (triggers lazy instantiation)
   */
  getEnabled(): ICompiler[] {
    return Array.from(this.entries.values())
      .filter((e) => e.enabled)
      .map((e) => this.ensureInstance(e))
      .filter((c): c is ICompiler => c !== undefined);
  }

  /**
   * Get local compilers (triggers lazy instantiation)
   */
  getLocal(): ICompiler[] {
    return this.getAll().filter((c) => !c.isRemote);
  }

  /**
   * Get remote compilers (triggers lazy instantiation)
   */
  getRemote(): ICompiler[] {
    return this.getAll().filter((c) => c.isRemote);
  }

  /**
   * Enable/disable compiler
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
   * Check if compiler is instantiated
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
      instantiated: boolean;
      extensions: string[];
      engines: string[];
    }
  > {
    const status: Record<
      string,
      {
        enabled: boolean;
        instantiated: boolean;
        extensions: string[];
        engines: string[];
      }
    > = {};

    for (const entry of this.entries.values()) {
      status[entry.id] = {
        enabled: entry.enabled,
        instantiated: entry.instance !== undefined,
        extensions: Array.from(entry.extensions),
        engines: Array.from(entry.engines),
      };
    }

    return status;
  }

  /**
   * Clear registry
   */
  clear(): void {
    this.entries.clear();
    this.extensionIndex.clear();
    this.engineIndex.clear();
  }

  /**
   * Get all registered compiler IDs
   */
  getRegisteredIds(): string[] {
    return Array.from(this.entries.keys());
  }

  // ============ Private Methods ============

  /**
   * Ensure compiler instance exists (lazy instantiation)
   */
  private ensureInstance(entry: RegistryEntry): ICompiler | undefined {
    if (entry.instance) {
      return entry.instance;
    }

    if (entry.factory) {
      try {
        entry.instance = new entry.factory();
        logger.info(`[Compiler Registry] Lazy instantiation: ${entry.id}`);
        this.emit('instantiated', { id: entry.id, compiler: entry.instance });
        return entry.instance;
      } catch (error) {
        console.error(`[Compiler Registry] Failed to instantiate ${entry.id}:`, error);
        this.emit('error', { id: entry.id, error: error as Error });
        return undefined;
      }
    }

    return undefined;
  }

  /**
   * Get highest priority compiler from a set of compiler IDs (triggers lazy instantiation)
   */
  private getHighestPriority(compilerIds: Set<string>): ICompiler | undefined {
    let highestPriority = Number.NEGATIVE_INFINITY;
    let resultEntry: RegistryEntry | undefined;

    for (const id of compilerIds) {
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
export const CompilerRegistry = new CompilerRegistryImpl();

// Export type (for testing or special scenarios)
export type { CompilerRegistryImpl };
