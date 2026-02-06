/**
 * @file TinymistService - Typst LSP integration
 * @description Provides Tinymist language server features via BaseLSPService
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
  type LSPTextEdit,
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

// ====== Tinymist Service ======

export class TinymistService extends BaseLSPService {
  // ====== ILanguageServer Properties ======

  readonly id = 'tinymist';
  readonly name = 'Tinymist';
  readonly languageIds = ['typst'];
  readonly extensions = ['.typ'];
  readonly capabilities: LSPServerCapabilities = {
    completion: true,
    hover: true,
    definition: true,
    references: true,
    documentSymbol: true,
    formatting: true,
    rename: true,
    foldingRange: true,
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
    return /tinymist\s+(\d+\.\d+\.\d+)/i;
  }

  protected getSpawnArgs(): string[] {
    // Tinymist requires the 'lsp' subcommand to start the server.
    return ['lsp'];
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
            insertReplaceSupport: true,
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
        formatting: {
          dynamicRegistration: false,
        },
        documentHighlight: {
          dynamicRegistration: false,
        },
        rename: {
          dynamicRegistration: false,
          prepareSupport: true,
        },
        inlayHint: {
          dynamicRegistration: false,
        },
        colorProvider: {
          dynamicRegistration: false,
        },
        foldingRange: {
          dynamicRegistration: false,
          lineFoldingOnly: true,
        },
        signatureHelp: {
          dynamicRegistration: false,
          signatureInformation: {
            documentationFormat: ['markdown', 'plaintext'],
            parameterInformation: {
              labelOffsetSupport: true,
            },
          },
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
   * Finds the Tinymist executable path.
   * @returns Absolute path or null when not found
   */
  protected async findExecutable(): Promise<string | null> {
    if (this.executablePath) return this.executablePath;

    const candidates: string[] = [];
    const binName = process.platform === 'win32' ? 'tinymist.exe' : 'tinymist';

    // Prefer explicit env override.
    if (process.env.TINYMIST_PATH) {
      candidates.push(process.env.TINYMIST_PATH);
    }

    // Prefer bundled app binary when present.
    const appBinPath = this.getAppBinPath();
    candidates.push(path.join(appBinPath, binName));

    // Fall back to common install locations.
    if (process.platform === 'win32') {
      candidates.push(
        'C:\\tinymist\\tinymist.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'tinymist', 'tinymist.exe'),
        path.join(process.env.PROGRAMFILES || '', 'tinymist', 'tinymist.exe'),
        // Cargo install path
        path.join(process.env.USERPROFILE || '', '.cargo', 'bin', 'tinymist.exe')
      );
    } else if (process.platform === 'darwin') {
      candidates.push(
        '/usr/local/bin/tinymist',
        '/opt/homebrew/bin/tinymist',
        path.join(process.env.HOME || '', '.cargo', 'bin', 'tinymist')
      );
    } else {
      candidates.push(
        '/usr/bin/tinymist',
        '/usr/local/bin/tinymist',
        path.join(process.env.HOME || '', '.cargo', 'bin', 'tinymist')
      );
    }

    // Finally, rely on PATH resolution.
    candidates.push(binName);

    return this.findExecutableInCandidates(candidates, binName);
  }

  // ====== Tinymist-Specific Features ======

  /**
   * Exports the current document as PDF.
   * @returns Success result or error message when LSP is unavailable
   */
  async exportPdf(
    filePath: string
  ): Promise<{ success: boolean; pdfPath?: string; error?: string }> {
    if (!this.isInitialized()) return { success: false, error: 'LSP not initialized' };

    try {
      // Tinymist uses a custom request for PDF export.
      const result = (await this.sendRequest('tinymist/exportPdf', {
        textDocument: { uri: this.pathToUri(filePath) },
      })) as { path?: string } | null;

      if (result?.path) {
        return { success: true, pdfPath: result.path };
      }
      return { success: false, error: 'Export failed' };
    } catch (error) {
      console.error('[Tinymist] Export PDF error:', error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * Retrieves HTML preview for a document.
   * @returns Success result or error message when LSP is unavailable
   */
  async getPreview(filePath: string): Promise<{ success: boolean; html?: string; error?: string }> {
    if (!this.isInitialized()) return { success: false, error: 'LSP not initialized' };

    try {
      const result = (await this.sendRequest('tinymist/preview', {
        textDocument: { uri: this.pathToUri(filePath) },
      })) as { html?: string } | null;

      if (result?.html) {
        return { success: true, html: result.html };
      }
      return { success: false, error: 'Preview failed' };
    } catch (error) {
      console.error('[Tinymist] Preview error:', error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * Formats document via LSP formatting request.
   * @returns Array of text edits, or empty list when not initialized
   */
  override async formatDocument(filePath: string): Promise<LSPTextEdit[]> {
    if (!this.isInitialized()) return [];

    try {
      const result = (await this.sendRequest('textDocument/formatting', {
        textDocument: { uri: this.pathToUri(filePath) },
        options: {
          tabSize: 2,
          insertSpaces: true,
        },
      })) as LSPTextEdit[] | null;

      return result || [];
    } catch (error) {
      console.error('[Tinymist] Format error:', error);
      return [];
    }
  }

  /**
   * Retrieves code actions for a range.
   * @returns Code actions, or empty list when not initialized
   */
  async getCodeActions(
    filePath: string,
    range: LSPRange,
    diagnostics: LSPDiagnostic[]
  ): Promise<Array<{ title: string; kind?: string; edit?: object }>> {
    if (!this.isInitialized()) return [];

    try {
      const result = (await this.sendRequest('textDocument/codeAction', {
        textDocument: { uri: this.pathToUri(filePath) },
        range,
        context: {
          diagnostics,
        },
      })) as Array<{ title: string; kind?: string; edit?: object }> | null;

      return result || [];
    } catch (error) {
      console.error('[Tinymist] Code actions error:', error);
      return [];
    }
  }
}

// ====== Singleton Access ======
let tinymistService: TinymistService | null = null;

/**
 * Returns the shared TinymistService instance.
 */
export function getTinymistService(): TinymistService {
  if (!tinymistService) {
    tinymistService = new TinymistService();
  }
  return tinymistService;
}
