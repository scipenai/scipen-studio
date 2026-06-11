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
    console.info('[LSPProviderRegistry] Already registered, skipping');
    return;
  }

  IsRegistered = true;
  console.info('[LSPProviderRegistry] Registering LSP providers...');

  const languages = ['latex', 'typst', 'markdown'];

  // Markdown semantic tokens provider (Marksman)
  monacoInstance.languages.registerDocumentSemanticTokensProvider('markdown', {
    getLegend() {
      return {
        tokenTypes: ['class', 'class', 'enumMember'],
        tokenModifiers: [],
      };
    },
    async provideDocumentSemanticTokens(model: monaco.editor.ITextModel) {
      if (!LSPService.isRunning()) return { data: new Uint32Array() };
      const filePath = normalizeModelPath(model.uri.path);
      if (!isLSPSupportedFile(filePath)) return { data: new Uint32Array() };

      try {
        const tokens = await LSPService.getSemanticTokens(filePath);
        return { data: new Uint32Array(tokens?.data || []) };
      } catch (error) {
        console.error('[LSP] Semantic tokens error:', error);
        return { data: new Uint32Array() };
      }
    },
    releaseDocumentSemanticTokens() {},
  });

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

  // Typst Completion Provider (tinymist) — registered for typst only, not latex/markdown:
  // - latex: texlab's \cite{} completion overlaps with BibTexSyncService's Zotero
  //   entries synced into .bib, so a single entry would appear twice; texlab's
  //   \ref{} is already covered by InlineCompletionService's LaTeX index. Adding
  //   tinymist here would produce three duplicates, so we skip it.
  // - markdown: marksman is not enabled; registering would just return empty.
  // - typst: tinymist provides <label> references (@fig-1/@tbl-x/@sec-) and
  //   built-in function completion. Coexists with CiteCompletionProvider via
  //   the shared '@' trigger; Monaco merges providers without preempting them,
  //   and each filterText splits the lane naturally:
  //     typing @fig-  → tinymist hits the label; Zotero cite is filtered out by
  //                     Monaco's fuzzy filter because filterText does not match.
  //     typing @liu   → Zotero cite hits the bibliography; tinymist usually has
  //                     no matching label and returns empty.
  //   '@' is a hard requirement for typst reference syntax; '#'/'.'/'('/','/' '
  //   are the standard typst function-call / method / argument-list triggers.
  monacoInstance.languages.registerCompletionItemProvider('typst', {
    triggerCharacters: ['@', '#', '.', ',', '(', ' '],
    provideCompletionItems: async (model: monaco.editor.ITextModel, position: monaco.Position) => {
      if (!LSPService.isRunning()) return { suggestions: [] };
      const filePath = normalizeModelPath(model.uri.path);
      if (!isLSPSupportedFile(filePath)) return { suggestions: [] };

      try {
        const items = await LSPService.getCompletions(filePath, position);
        return { suggestions: items };
      } catch (error) {
        console.error('[LSP] Typst completion error:', error);
        return { suggestions: [] };
      }
    },
  });

  console.info('[LSPProviderRegistry] LSP providers registered for:', languages.join(', '));
}

/**
 * Resets registration state (for testing).
 */
export function resetLSPProviderRegistry(): void {
  IsRegistered = false;
}
