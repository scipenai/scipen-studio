/**
 * @file ServiceContainer - Lightweight dependency injection container
 * @description Provides service lifecycle management and DI.
 *   - Singleton: Created once for entire app lifecycle
 *   - Transient: New instance per request
 *   - Lazy: Created on first access
 */

/** Service lifecycle policy. */
export type ServiceLifetime = 'singleton' | 'transient' | 'lazy';

/** Service factory function. */
export type ServiceFactory<T> = (container: ServiceContainer) => T;

/** Interface for disposable services. */
export interface IDisposable {
  dispose(): void | Promise<void>;
}

interface ServiceRegistration<T = unknown> {
  factory: ServiceFactory<T>;
  lifetime: ServiceLifetime;
  instance?: T;
}

/** Lightweight dependency injection container. */
export class ServiceContainer {
  private registrations: Map<string, ServiceRegistration> = new Map();
  private disposables: Set<IDisposable> = new Set();

  /** Register a singleton service. */
  registerSingleton<T>(name: string, factory: ServiceFactory<T>): this {
    this.registrations.set(name, {
      factory,
      lifetime: 'singleton',
    });
    return this;
  }

  /** Register a transient service (new instance per request). */
  registerTransient<T>(name: string, factory: ServiceFactory<T>): this {
    this.registrations.set(name, {
      factory,
      lifetime: 'transient',
    });
    return this;
  }

  /** Register a lazy singleton (created on first access). */
  registerLazy<T>(name: string, factory: ServiceFactory<T>): this {
    this.registrations.set(name, {
      factory,
      lifetime: 'lazy',
    });
    return this;
  }

  /** Register an existing instance. */
  registerInstance<T>(name: string, instance: T): this {
    this.registrations.set(name, {
      factory: () => instance,
      lifetime: 'singleton',
      instance,
    });

    if (this.isDisposable(instance)) {
      this.disposables.add(instance);
    }

    return this;
  }

  /**
   * @throws Error when service is not registered.
   */
  get<T>(name: string): T {
    const registration = this.registrations.get(name);

    if (!registration) {
      throw new Error(`Service not registered: ${name}`);
    }

    if (
      (registration.lifetime === 'singleton' || registration.lifetime === 'lazy') &&
      registration.instance
    ) {
      return registration.instance as T;
    }

    const instance = registration.factory(this);

    if (registration.lifetime === 'singleton' || registration.lifetime === 'lazy') {
      registration.instance = instance;
    }

    if (this.isDisposable(instance)) {
      this.disposables.add(instance);
    }

    return instance as T;
  }

  /** Try get service, returns undefined if not found. */
  tryGet<T>(name: string): T | undefined {
    try {
      return this.get<T>(name);
    } catch {
      return undefined;
    }
  }

  /** Check if service is registered. */
  has(name: string): boolean {
    return this.registrations.has(name);
  }

  /** Eagerly instantiate specified services. */
  warmup(...names: string[]): void {
    for (const name of names) {
      this.get(name);
    }
  }

  /** Dispose all services and clear registrations. */
  async dispose(): Promise<void> {
    const disposePromises: Promise<void>[] = [];

    for (const disposable of this.disposables) {
      try {
        const result = disposable.dispose();
        if (result instanceof Promise) {
          disposePromises.push(result);
        }
      } catch (error) {
        console.error('[ServiceContainer] Error disposing service:', error);
      }
    }

    await Promise.all(disposePromises);

    this.disposables.clear();
    this.registrations.clear();
  }

  private isDisposable(obj: unknown): obj is IDisposable {
    return (
      obj !== null &&
      typeof obj === 'object' &&
      'dispose' in obj &&
      typeof (obj as IDisposable).dispose === 'function'
    );
  }

  /** Get all registered service names. */
  getRegisteredServices(): string[] {
    return Array.from(this.registrations.keys());
  }

  /** Get service statistics for diagnostics. */
  getStats(): {
    registered: number;
    instantiated: number;
    disposables: number;
  } {
    let instantiated = 0;
    for (const reg of this.registrations.values()) {
      if (reg.instance !== undefined) {
        instantiated++;
      }
    }

    return {
      registered: this.registrations.size,
      instantiated,
      disposables: this.disposables.size,
    };
  }
}

// ====== Global Container ======

let globalContainer: ServiceContainer | null = null;

/** Get global service container instance. */
export function getServiceContainer(): ServiceContainer {
  if (!globalContainer) {
    globalContainer = new ServiceContainer();
  }
  return globalContainer;
}

/** Reset global container (for tests). */
export async function resetServiceContainer(): Promise<void> {
  if (globalContainer) {
    await globalContainer.dispose();
    globalContainer = null;
  }
}

// ====== Service Name Constants ======

/** Predefined service names. */
export const ServiceNames = {
  FILE_SYSTEM: 'fileSystem',
  LATEX_COMPILER: 'latexCompiler',
  OVERLEAF_COMPILER: 'overleafCompiler',
  OVERLEAF_FILE_SYSTEM: 'overleafFileSystem',
  SYNCTEX: 'synctex',
  CONFIG: 'config',
  LOGGER: 'logger',
  TRACE: 'trace',

  LSP_MANAGER: 'lspManager',
  TEXLAB: 'texlab',
  TINYMIST: 'tinymist',

  KNOWLEDGE: 'knowledge',
  EMBEDDING: 'embedding',
  VECTOR_STORE: 'vectorStore',
  DOCUMENT_STORE: 'documentStore',
  HYBRID_RETRIEVER: 'hybridRetriever',
  RERANKER: 'reranker',
  SELECTION: 'selection',

  AI: 'ai',
  AGENT: 'agent',
  CHAT_ORCHESTRATOR: 'chatOrchestrator',

  VECTOR_SEARCH_CLIENT: 'vectorSearchClient',
  SQLITE_WORKER_CLIENT: 'sqliteWorkerClient',
} as const;

/** Union of all service name values. */
export type ServiceName = (typeof ServiceNames)[keyof typeof ServiceNames];
