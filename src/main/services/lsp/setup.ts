/**
 * @file LSP Service Initialization
 * @description Registers all language servers at app startup.
 *              Centralized LSP service registration for easy language extension.
 */

import { createLogger } from '../LoggerService';
import { TexLabService } from '../TexLabService';
import { TinymistService } from '../TinymistService';
import { LSPRegistry } from './LSPRegistry';

const logger = createLogger('LSPSetup');

/**
 * @sideeffect Registers language servers in the LSP registry.
 * @remarks Uses lazy loading: servers instantiate only on first use to reduce startup time.
 */
export function initializeLSPRegistry(): void {
  logger.info('[LSP Setup] Initializing LSP Registry (lazy mode)...');

  LSPRegistry.register({
    id: 'texlab',
    server: TexLabService,
    enabled: true,
    priority: 10,
    languageIds: ['latex', 'bibtex'],
    extensions: ['.tex', '.bib', '.sty', '.cls', '.dtx', '.ins'],
  });

  LSPRegistry.register({
    id: 'tinymist',
    server: TinymistService,
    enabled: true,
    priority: 10,
    languageIds: ['typst'],
    extensions: ['.typ'],
  });

  logger.info('[LSP Setup] LSP Registry initialized (servers instantiate on first use)');
  logger.info('[LSP Setup] Registered service IDs:', LSPRegistry.getRegisteredIds().join(', '));
}

/** Start all registered LSP servers */
export async function startAllLSPServers(
  rootPath: string,
  options?: { virtual?: boolean }
): Promise<Record<string, boolean>> {
  return LSPRegistry.startAll(rootPath, options);
}

/** Stop all LSP servers */
export async function stopAllLSPServers(): Promise<void> {
  return LSPRegistry.stopAll();
}

/**
 * @remarks Returns null when no registered server matches the file.
 */
export function getLSPServerForFile(filePath: string) {
  return LSPRegistry.getByFilePath(filePath);
}

export { LSPRegistry } from './LSPRegistry';
