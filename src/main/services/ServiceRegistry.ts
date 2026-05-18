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
import { createConfigManager } from './ConfigManager';
import { createFileSystemService } from './FileSystemService';
import { createInlineEditService } from './InlineEditService';
import { getLSPProcessClient } from './LSPProcessClient';
import { LaTeXCompiler } from './LaTeXCompiler';
import { SelectionService } from './SelectionService';
import { createSyncTeXService } from './SyncTeXService';
import { StudioIMService } from './StudioIMService';
import { StudioOTService } from './StudioOTService';
import { StudioOverleafLiveService } from './StudioOverleafLiveService';
import { ProjectBindingService } from './ProjectBindingService';
import { ProjectConversationService } from './ProjectConversationService';
import { ReplicaWritebackService } from './ReplicaWritebackService';
import { ExternalChangeDetector } from './ExternalChangeDetector';
import { OfflineOpsStore } from './OfflineOpsStore';
import { OfflineOpsManager } from './OfflineOpsManager';
import { createSnacaSidecarService } from './agent/SnacaSidecarService';
import { createEditorProtocolClient } from './agent/EditorProtocolClient';
import { createAgentEditApplyService } from './agent/AgentEditApplyService';
import {
  createContextRequestService,
  defaultGetRendererWebContents,
} from './agent/ContextRequestService';
import type { ISnacaSidecarService } from './agent/interfaces/ISnacaSidecarService';
import type { IEditorProtocolClient } from './agent/interfaces/IEditorProtocolClient';
import path from 'path';
import { app, BrowserWindow } from 'electron';

import { TraceService } from './TraceService';
import { ChatOrchestrator } from './chat';
import type { IConfigManager } from './interfaces';
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
  container.registerLazy(ServiceNames.INLINE_EDIT, () =>
    createInlineEditService({
      aiService: container.get<IAIService>(ServiceNames.AI),
    })
  );
  // Chat orchestrator for conversation mode
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
  container.registerSingleton(ServiceNames.STUDIO_IM, () => new StudioIMService());
  container.registerSingleton(ServiceNames.STUDIO_OT, () => new StudioOTService());
  container.registerSingleton(
    ServiceNames.STUDIO_OVERLEAF_LIVE,
    () => new StudioOverleafLiveService()
  );
  container.registerSingleton(ServiceNames.PROJECT_BINDING, () => new ProjectBindingService());
  container.registerSingleton(
    ServiceNames.PROJECT_CONVERSATION,
    () => new ProjectConversationService()
  );
  container.registerSingleton(ServiceNames.REPLICA_WRITEBACK, () => new ReplicaWritebackService());
  container.registerSingleton(
    ServiceNames.EXTERNAL_CHANGE_DETECTOR,
    () => new ExternalChangeDetector()
  );
  container.registerSingleton(ServiceNames.OFFLINE_OPS_STORE, () => new OfflineOpsStore());
  container.registerSingleton(
    ServiceNames.OFFLINE_OPS_MANAGER,
    () =>
      new OfflineOpsManager(
        container.get<StudioOTService>(ServiceNames.STUDIO_OT),
        container.get<OfflineOpsStore>(ServiceNames.OFFLINE_OPS_STORE)
      )
  );

  // ====== Agent (SNACA sidecar + editor-protocol client) ======

  container.registerLazy(ServiceNames.AGENT_SIDECAR, () =>
    createSnacaSidecarService({
      binaryPath: resolveSnacaEditorBinaryPath(),
      env: {
        // API key is read from the parent process env at sidecar spawn time.
        // The sidecar's `snaca.toml` only carries the env variable name,
        // never the key itself.
        SNACA_API_KEY: process.env.SNACA_API_KEY ?? '',
        RUST_LOG: process.env.SNACA_LOG ?? 'snaca_editor=info,info',
      },
      autoRestart: true,
    })
  );
  container.registerLazy(ServiceNames.AGENT_PROTOCOL_CLIENT, () =>
    createEditorProtocolClient({
      sidecar: container.get<ISnacaSidecarService>(ServiceNames.AGENT_SIDECAR),
    })
  );

  container.registerLazy(ServiceNames.AGENT_EDIT_APPLY, () =>
    createAgentEditApplyService({
      client: container.get<IEditorProtocolClient>(ServiceNames.AGENT_PROTOCOL_CLIENT),
      fileSystem: container.get<IFileSystemService>(ServiceNames.FILE_SYSTEM),
    })
  );

  container.registerLazy(ServiceNames.AGENT_CONTEXT_REQUEST, () =>
    createContextRequestService({
      getRendererWebContents: defaultGetRendererWebContents(BrowserWindow),
      fileSystem: container.get<IFileSystemService>(ServiceNames.FILE_SYSTEM),
    })
  );

  // ====== LSP Services ======

  // LSP runs in a separate UtilityProcess for isolation
  container.registerInstance(ServiceNames.LSP_MANAGER, getLSPProcessClient());

  // ====== Worker Clients ======

  logger.info(
    '[ServiceRegistry] Services registered:',
    container.getRegisteredServices().join(', ')
  );
}

/**
 * Resolve the snaca-editor binary path.
 *
 * - In dev: `<repo>/snaca/target/debug/snaca-editor[.exe]` — the in-tree
 *   Rust workspace, built with `cargo build --bin snaca-editor`.
 * - Packaged: `resources/bin/snaca-editor[.exe]` (see electron-builder
 *   `extraResources`).
 *
 * Override via `SNACA_EDITOR_PATH` env if the developer wants a custom build.
 */
function resolveSnacaEditorBinaryPath(): string {
  if (process.env.SNACA_EDITOR_PATH) {
    return process.env.SNACA_EDITOR_PATH;
  }
  const ext = process.platform === 'win32' ? '.exe' : '';
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin', `snaca-editor${ext}`);
  }
  return path.join(app.getAppPath(), 'snaca', 'target', 'debug', `snaca-editor${ext}`);
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
 * @sideeffect Closes DB connections, terminates workers
 */
export async function shutdownServices(): Promise<void> {
  const container = getServiceContainer();

  logger.info('[ServiceRegistry] Shutting down services...');

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

export function getSyncTeXServiceFromContainer(): ISyncTeXService {
  return getServiceContainer().get<ISyncTeXService>(ServiceNames.SYNCTEX);
}

export function getSelectionServiceFromContainer(): ISelectionService {
  return getServiceContainer().get<ISelectionService>(ServiceNames.SELECTION);
}

export function getChatOrchestrator(): IChatOrchestrator {
  return getServiceContainer().get<IChatOrchestrator>(ServiceNames.CHAT_ORCHESTRATOR);
}

export function getStudioIMService(): StudioIMService {
  return getServiceContainer().get<StudioIMService>(ServiceNames.STUDIO_IM);
}

export function getStudioOverleafLiveService(): StudioOverleafLiveService {
  return getServiceContainer().get<StudioOverleafLiveService>(ServiceNames.STUDIO_OVERLEAF_LIVE);
}

export function getStudioOTService(): StudioOTService {
  return getServiceContainer().get<StudioOTService>(ServiceNames.STUDIO_OT);
}

export function getProjectBindingService(): ProjectBindingService {
  return getServiceContainer().get<ProjectBindingService>(ServiceNames.PROJECT_BINDING);
}

export function getProjectConversationService(): ProjectConversationService {
  return getServiceContainer().get<ProjectConversationService>(ServiceNames.PROJECT_CONVERSATION);
}

export function getReplicaWritebackService(): ReplicaWritebackService {
  return getServiceContainer().get<ReplicaWritebackService>(ServiceNames.REPLICA_WRITEBACK);
}

export function getExternalChangeDetector(): ExternalChangeDetector {
  return getServiceContainer().get<ExternalChangeDetector>(ServiceNames.EXTERNAL_CHANGE_DETECTOR);
}

export function getOfflineOpsStore(): OfflineOpsStore {
  return getServiceContainer().get<OfflineOpsStore>(ServiceNames.OFFLINE_OPS_STORE);
}

export function getOfflineOpsManager(): OfflineOpsManager {
  return getServiceContainer().get<OfflineOpsManager>(ServiceNames.OFFLINE_OPS_MANAGER);
}
