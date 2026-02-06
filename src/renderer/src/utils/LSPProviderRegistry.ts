/**
 * @file LSPProviderRegistry.ts - LSP provider registration management
 * @description Ensures Monaco LSP providers are registered only once to avoid issues caused by duplicate registration
 * @depends LSPService, monaco-editor
 */

import type { Monaco } from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import { LSPService, isLSPSupportedFile, normalizeModelPath } from '../services/LSPService';

// ====== Registration State ======

let IsRegistered = false;

/**
 * Checks if LSP providers are registered.
 */
export function isLSPProvidersRegistered(): boolean {
  return IsRegistered;
}

/**
 * Registers LSP providers for Monaco (idempotent - only runs once).
 */
export function registerLSPProviders(monacoInstance: Monaco): void {
  if (IsRegistered) {
    console.log('[LSPProviderRegistry] Already registered, skipping');
    return;
  }

  IsRegistered = true;
  console.log('[LSPProviderRegistry] Registering LSP providers...');

  const languages = ['latex', 'typst'];

  for (const languageId of languages) {
    // Hover Provider
    monacoInstance.languages.registerHoverProvider(languageId, {
      provideHover: async (model: monaco.editor.ITextModel, position: monaco.Position) => {
        if (!LSPService.isRunning()) return null;
        const filePath = normalizeModelPath(model.uri.path);
        if (!isLSPSupportedFile(filePath)) return null;

        try {
          return await LSPService.getHover(filePath, position);
        } catch (error) {
          console.error('[LSP] Hover error:', error);
          return null;
        }
      },
    });

    // Definition Provider (Go to Definition)
    monacoInstance.languages.registerDefinitionProvider(languageId, {
      provideDefinition: async (model: monaco.editor.ITextModel, position: monaco.Position) => {
        if (!LSPService.isRunning()) return null;
        const filePath = normalizeModelPath(model.uri.path);
        if (!isLSPSupportedFile(filePath)) return null;

        try {
          return await LSPService.getDefinition(filePath, position);
        } catch (error) {
          console.error('[LSP] Definition error:', error);
          return null;
        }
      },
    });

    // References Provider (Find All References)
    monacoInstance.languages.registerReferenceProvider(languageId, {
      provideReferences: async (
        model: monaco.editor.ITextModel,
        position: monaco.Position,
        context: monaco.languages.ReferenceContext
      ) => {
        if (!LSPService.isRunning()) return null;
        const filePath = normalizeModelPath(model.uri.path);
        if (!isLSPSupportedFile(filePath)) return null;

        try {
          return await LSPService.getReferences(filePath, position, context.includeDeclaration);
        } catch (error) {
          console.error('[LSP] References error:', error);
          return null;
        }
      },
    });

    // Document Symbol Provider (Outline)
    monacoInstance.languages.registerDocumentSymbolProvider(languageId, {
      provideDocumentSymbols: async (model: monaco.editor.ITextModel) => {
        if (!LSPService.isRunning()) return null;
        const filePath = normalizeModelPath(model.uri.path);
        if (!isLSPSupportedFile(filePath)) return null;

        try {
          return await LSPService.getDocumentSymbols(filePath);
        } catch (error) {
          console.error('[LSP] Document symbols error:', error);
          return null;
        }
      },
    });
  }

  console.log('[LSPProviderRegistry] LSP providers registered for:', languages.join(', '));
}

/**
 * Resets registration state (for testing).
 */
export function resetLSPProviderRegistry(): void {
  IsRegistered = false;
}
