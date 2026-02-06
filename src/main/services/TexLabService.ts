/**
 * @file TexLabService - LaTeX LSP integration
 * @description Provides TexLab language server features via BaseLSPService
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

// ====== TexLab Service ======

export class TexLabService extends BaseLSPService {
  // ====== ILanguageServer Properties ======

  readonly id = 'texlab';
  readonly name = 'TexLab';
  readonly languageIds = ['latex', 'bibtex'];
  readonly extensions = ['.tex', '.latex', '.ltx', '.sty', '.cls', '.bib'];
  readonly capabilities: LSPServerCapabilities = {
    completion: true,
    hover: true,
    definition: true,
    references: true,
    documentSymbol: true,
    formatting: false, // TexLab does not support formatting
    rename: true,
    foldingRange: true,
    codeAction: true,
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
    return /texlab\s+(\d+\.\d+\.\d+)/i;
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
      },
      workspace: {
        workspaceFolders: true,
        configuration: true,
      },
    };
  }

  /**
   * Finds the TexLab executable path.
   * @returns Absolute path or null when not found
   */
  protected async findExecutable(): Promise<string | null> {
    if (this.executablePath) return this.executablePath;

    const candidates: string[] = [];
    const binName = process.platform === 'win32' ? 'texlab.exe' : 'texlab';

    // Prefer explicit env override.
    if (process.env.TEXLAB_PATH) {
      candidates.push(process.env.TEXLAB_PATH);
    }

    // Prefer bundled app binary when present.
    const appBinPath = this.getAppBinPath();
    candidates.push(path.join(appBinPath, binName));

    // Fall back to common install locations.
    if (process.platform === 'win32') {
      candidates.push(
        'C:\\texlab\\texlab.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'texlab', 'texlab.exe'),
        path.join(process.env.PROGRAMFILES || '', 'texlab', 'texlab.exe')
      );
    } else if (process.platform === 'darwin') {
      candidates.push(
        '/usr/local/bin/texlab',
        '/opt/homebrew/bin/texlab',
        path.join(process.env.HOME || '', '.cargo', 'bin', 'texlab')
      );
    } else {
      candidates.push(
        '/usr/bin/texlab',
        '/usr/local/bin/texlab',
        path.join(process.env.HOME || '', '.cargo', 'bin', 'texlab')
      );
    }

    // Finally, rely on PATH resolution.
    candidates.push(binName);

    return this.findExecutableInCandidates(candidates, binName);
  }

  // ====== TexLab-Specific Features ======

  /**
   * Builds project via TexLab LSP request.
   * @returns Status result, or error when LSP is unavailable
   */
  async build(filePath: string): Promise<{ status: string }> {
    if (!this.isInitialized()) return { status: 'error' };

    try {
      const result = (await this.sendRequest('textDocument/build', {
        textDocument: { uri: this.pathToUri(filePath) },
      })) as { status: number };

      return { status: result.status === 0 ? 'success' : 'error' };
    } catch (error) {
      console.error('[TexLab] Build error:', error);
      return { status: 'error' };
    }
  }

  /**
   * Forward search from source to PDF position.
   * @returns Status result, or error when LSP is unavailable
   */
  async forwardSearch(filePath: string, line: number): Promise<{ status: string }> {
    if (!this.isInitialized()) return { status: 'error' };

    try {
      const result = (await this.sendRequest('textDocument/forwardSearch', {
        textDocument: { uri: this.pathToUri(filePath) },
        position: { line, character: 0 },
      })) as { status: number };

      return { status: result.status === 0 ? 'success' : 'error' };
    } catch (error) {
      console.error('[TexLab] Forward search error:', error);
      return { status: 'error' };
    }
  }
}

// ====== Singleton Access ======
let texlabService: TexLabService | null = null;

/**
 * Returns the shared TexLabService instance.
 */
export function getTexLabService(): TexLabService {
  if (!texlabService) {
    texlabService = new TexLabService();
  }
  return texlabService;
}
