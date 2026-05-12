/**
 * @file MarkmanService - Markdown LSP integration
 * @description Provides Marksman language server features via BaseLSPService
 * @depends BaseLSPService
 */

import * as path from 'path';
import {
  BaseLSPService,
  type LSPCompletionItem,
  type LSPDiagnostic,
  type LSPDocumentSymbol,
  type LSPHover,
  type LSPLocation,
  type LSPPosition,
  type LSPRange,
  type LSPSymbol,
} from './BaseLSPService';
import type { LSPServerCapabilities } from './lsp/interfaces';

// Re-export types for external use.
export type {
  LSPCompletionItem,
  LSPDiagnostic,
  LSPDocumentSymbol,
  LSPHover,
  LSPLocation,
  LSPPosition,
  LSPRange,
  LSPSymbol,
};

// ====== Marksman Service ======

export class MarkmanService extends BaseLSPService {
  // ====== ILanguageServer Properties ======

  readonly id = 'marksman';
  readonly name = 'Marksman';
  readonly languageIds = ['markdown'];
  readonly extensions = ['.md', '.markdown', '.mdx'];
  readonly capabilities: LSPServerCapabilities = {
    completion: true,
    hover: true,
    definition: true,
    references: true,
    documentSymbol: true,
    formatting: false,
    rename: true,
    foldingRange: false,
    codeAction: true,
    semanticTokens: true,
  };

  // ====== BaseLSPService Overrides ======

  getServiceName(): string {
    return this.name;
  }

  getDefaultLanguageId(): string {
    return this.languageIds[0];
  }

  getSupportedExtensions(): string[] {
    return [...this.extensions];
  }

  protected getVersionRegex(): RegExp {
    return /marksman\s+(\d+[.-]\d+[.-]\d+)/i;
  }

  protected getSpawnArgs(): string[] {
    // Marksman uses the 'server' subcommand to start the LSP server.
    return ['server'];
  }

  protected getInitializeCapabilities(): object {
    return {
      textDocument: {
        synchronization: {
          dynamicRegistration: false,
          willSave: false,
          willSaveWaitUntil: false,
          didSave: true,
        },
        completion: {
          dynamicRegistration: false,
          completionItem: {
            snippetSupport: true,
            documentationFormat: ['markdown', 'plaintext'],
            resolveSupport: { properties: ['documentation', 'detail'] },
          },
          contextSupport: true,
        },
        hover: {
          dynamicRegistration: false,
          contentFormat: ['markdown', 'plaintext'],
        },
        definition: { dynamicRegistration: false },
        references: { dynamicRegistration: false },
        documentSymbol: {
          dynamicRegistration: false,
          hierarchicalDocumentSymbolSupport: true,
        },
        publishDiagnostics: {
          relatedInformation: true,
        },
        codeAction: {
          dynamicRegistration: false,
          codeActionLiteralSupport: {
            codeActionKind: {
              valueSet: ['quickfix', 'refactor', 'source'],
            },
          },
        },
        rename: {
          dynamicRegistration: false,
          prepareSupport: true,
        },
        semanticTokens: {
          dynamicRegistration: false,
          requests: {
            range: true,
            full: { delta: false },
          },
          tokenTypes: ['class', 'enumMember'],
          tokenModifiers: [],
          formats: ['relative'],
          overlappingTokenSupport: false,
          multilineTokenSupport: false,
        },
      },
      workspace: {
        workspaceFolders: true,
        configuration: true,
        didChangeConfiguration: {
          dynamicRegistration: false,
        },
      },
      window: {
        workDoneProgress: true,
      },
    };
  }

  /**
   * Finds the Marksman executable path.
   * @returns Absolute path or null when not found
   */
  protected async findExecutable(): Promise<string | null> {
    if (this.executablePath) return this.executablePath;

    const candidates: string[] = [];
    const binName = process.platform === 'win32' ? 'marksman.exe' : 'marksman';

    // Prefer explicit env override.
    if (process.env.MARKSMAN_PATH) {
      candidates.push(process.env.MARKSMAN_PATH);
    }

    // Prefer bundled app binary when present.
    const appBinPath = this.getAppBinPath();
    candidates.push(path.join(appBinPath, binName));

    // Fall back to common install locations.
    if (process.platform === 'win32') {
      candidates.push(
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'marksman', 'marksman.exe'),
        path.join(process.env.PROGRAMFILES || '', 'marksman', 'marksman.exe')
      );
    } else if (process.platform === 'darwin') {
      candidates.push(
        '/usr/local/bin/marksman',
        '/opt/homebrew/bin/marksman',
        path.join(process.env.HOME || '', '.local', 'bin', 'marksman')
      );
    } else {
      candidates.push(
        '/usr/bin/marksman',
        '/usr/local/bin/marksman',
        path.join(process.env.HOME || '', '.local', 'bin', 'marksman')
      );
    }

    // Finally, rely on PATH resolution.
    candidates.push(binName);

    return this.findExecutableInCandidates(candidates, binName);
  }
}

// ====== Singleton Access ======
let markmanService: MarkmanService | null = null;

/**
 * Returns the shared MarkmanService instance.
 */
export function getMarkmanService(): MarkmanService {
  if (!markmanService) {
    markmanService = new MarkmanService();
  }
  return markmanService;
}
