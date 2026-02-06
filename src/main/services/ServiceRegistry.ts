/**
 * @file ServiceRegistry - Application service registration
 * @description Registers all services at application startup using dependency injection.
 * @depends ServiceContainer, all service factories and worker clients
 * @sideeffect Populates the global ServiceContainer with service instances
 */

import { LoggerService, createLogger } from './LoggerService';
import { ServiceNames, getServiceContainer } from './ServiceContainer';

const logger = createLogger('ServiceRegistry');

// ====== Service Factory Imports ======

import { createAIService } from './AIService';
import { createAgentService } from './AgentService';
import { createConfigManager } from './ConfigManager';
import { createFileSystemService } from './FileSystemService';
import { getLSPProcessClient } from './LSPProcessClient';
import { LaTeXCompiler } from './LaTeXCompiler';
import { SelectionService } from './SelectionService';
import { createSyncTeXService } from './SyncTeXService';
import { TraceService } from './TraceService';
import { ChatOrchestrator } from './chat';
import type { IAgentService, IConfigManager } from './interfaces';
import type {
  IAIService,
  IFileSystemService,
  ISelectionService,
  ISyncTeXService,
} from './interfaces';
import type { IChatOrchestrator } from './interfaces/IChatOrchestrator';

// ====== Worker Client Imports ======

import { compileWorkerClient } from '../workers/CompileWorkerClient';
import { getFileWorkerClient } from '../workers/FileWorkerClient';
import { getLogParserClient } from '../workers/LogParserClient';
import { getPDFWorkerClient } from '../workers/PDFWorkerClient';
import { getSQLiteWorkerClient } from '../workers/SQLiteWorkerClient';
import { getVectorSearchClient } from '../workers/VectorSearchClient';

// ====== Service Registration ======

/**
 * Initialize and register all services to the DI container.
 * @sideeffect Populates ServiceContainer with all application services
 */
export function registerServices(): void {
  const container = getServiceContainer();

  logger.info('[ServiceRegistry] Registering services...');

  // ====== Core Services ======

  container.registerSingleton<IConfigManager>(ServiceNames.CONFIG, () => createConfigManager());
  container.registerInstance(ServiceNames.LOGGER, LoggerService);
  container.registerInstance(ServiceNames.TRACE, TraceService);
  container.registerSingleton<IFileSystemService>(ServiceNames.FILE_SYSTEM, () =>
    createFileSystemService()
  );
  container.registerSingleton(ServiceNames.LATEX_COMPILER, () => {
    return new LaTeXCompiler();
  });
  // Lazy init: SyncTeX service is rarely used at startup
  container.registerLazy<ISyncTeXService>(ServiceNames.SYNCTEX, () => createSyncTeXService());

  // ====== AI Services ======

  container.registerSingleton<IAIService>(ServiceNames.AI, () => createAIService());
  // Agent tools: PDF2LaTeX, Paper2Beamer, Reviewer
  container.registerSingleton<IAgentService>(ServiceNames.AGENT, () =>
    createAgentService(container.get<IConfigManager>(ServiceNames.CONFIG))
  );
  // Chat orchestrator for Ask mode
  container.registerSingleton<IChatOrchestrator>(
    ServiceNames.CHAT_ORCHESTRATOR,
    () =>
      new ChatOrchestrator(
        container.get<IAIService>(ServiceNames.AI),
        container.get<IFileSystemService>(ServiceNames.FILE_SYSTEM)
      )
  );
  container.registerSingleton<ISelectionService>(
    ServiceNames.SELECTION,
    () => new SelectionService()
  );

  // ====== LSP Services ======

  // LSP runs in a separate UtilityProcess for isolation
  container.registerInstance(ServiceNames.LSP_MANAGER, getLSPProcessClient());

  // ====== Worker Clients ======

  container.registerInstance(ServiceNames.VECTOR_SEARCH_CLIENT, getVectorSearchClient());
  container.registerInstance(ServiceNames.SQLITE_WORKER_CLIENT, getSQLiteWorkerClient());

  logger.info(
    '[ServiceRegistry] Services registered:',
    container.getRegisteredServices().join(', ')
  );
}

// ====== Service Lifecycle ======

/**
 * Pre-initialize frequently used services to reduce first-use latency.
 * @sideeffect Triggers lazy service initialization
 */
export async function warmupServices(): Promise<void> {
  const container = getServiceContainer();

  logger.info('[ServiceRegistry] Warming up services...');

  container.warmup(ServiceNames.FILE_SYSTEM);
  container.warmup(ServiceNames.LATEX_COMPILER);

  logger.info('[ServiceRegistry] Services warmed up');
}

/**
 * Gracefully shutdown all services and workers.
 * @sideeffect Persists HNSW index, closes DB connections, terminates workers
 */
export async function shutdownServices(): Promise<void> {
  const container = getServiceContainer();

  logger.info('[ServiceRegistry] Shutting down services...');

  // Workers must be closed first to allow state persistence (e.g., HNSW index)
  logger.info('[ServiceRegistry] Closing worker clients...');

  const workerShutdownPromises: Promise<void>[] = [];

  try {
    workerShutdownPromises.push(compileWorkerClient.close());
  } catch {
    logger.error('[ServiceRegistry] Failed to close CompileWorkerClient');
  }

  try {
    const fileWorkerClient = getFileWorkerClient();
    workerShutdownPromises.push(fileWorkerClient.close());
  } catch {
    logger.error('[ServiceRegistry] Failed to close FileWorkerClient');
  }

  try {
    const pdfWorkerClient = getPDFWorkerClient();
    workerShutdownPromises.push(pdfWorkerClient.close());
  } catch {
    logger.error('[ServiceRegistry] Failed to close PDFWorkerClient');
  }

  try {
    const logParserClient = getLogParserClient();
    workerShutdownPromises.push(logParserClient.terminate());
  } catch {
    logger.error('[ServiceRegistry] Failed to close LogParserClient');
  }

  // Critical: VectorSearchClient must persist HNSW index before termination
  try {
    const vectorSearchClient = getVectorSearchClient();
    workerShutdownPromises.push(vectorSearchClient.terminate());
  } catch {
    logger.error('[ServiceRegistry] Failed to close VectorSearchClient');
  }

  // Critical: SQLiteWorkerClient must close DB connections properly
  try {
    const sqliteWorkerClient = getSQLiteWorkerClient();
    workerShutdownPromises.push(sqliteWorkerClient.terminate());
  } catch {
    logger.error('[ServiceRegistry] Failed to close SQLiteWorkerClient');
  }

  try {
    const lspClient = getLSPProcessClient();
    workerShutdownPromises.push(lspClient.stopProcess());
  } catch {
    logger.error('[ServiceRegistry] Failed to close LSPProcessClient');
  }

  // Wait for workers with 10s timeout to prevent hanging on exit
  try {
    await Promise.race([
      Promise.all(workerShutdownPromises),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Worker shutdown timeout')), 10000)
      ),
    ]);
    logger.info('[ServiceRegistry] Worker clients closed');
  } catch {
    logger.error('[ServiceRegistry] Worker shutdown timeout or failed');
  }

  await container.dispose();

  logger.info('[ServiceRegistry] Services shutdown complete');
}

// ====== Service Accessors ======

/** Generic service getter */
export function getService<T>(name: string): T {
  return getServiceContainer().get<T>(name);
}

/** Generic service getter (returns undefined if not found) */
export function tryGetService<T>(name: string): T | undefined {
  return getServiceContainer().tryGet<T>(name);
}

// ====== Type-Safe Service Getters ======

export function getFileSystemService(): IFileSystemService {
  return getServiceContainer().get<IFileSystemService>(ServiceNames.FILE_SYSTEM);
}

export function getAIService(): IAIService {
  return getServiceContainer().get<IAIService>(ServiceNames.AI);
}

export function getAgentService(): IAgentService {
  return getServiceContainer().get<IAgentService>(ServiceNames.AGENT);
}

export function getSyncTeXServiceFromContainer(): ISyncTeXService {
  return getServiceContainer().get<ISyncTeXService>(ServiceNames.SYNCTEX);
}

export function getSelectionServiceFromContainer(): ISelectionService {
  return getServiceContainer().get<ISelectionService>(ServiceNames.SELECTION);
}

export function getChatOrchestrator(): IChatOrchestrator {
  return getServiceContainer().get<IChatOrchestrator>(ServiceNames.CHAT_ORCHESTRATOR);
}
