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

  // Typst Completion Provider (tinymist) —— 单挂 typst,不挂 latex/markdown:
  // - latex:texlab 的 \cite{} completion 与 BibTexSyncService 同步入 .bib 的 Zotero
  //   entry 会重复出现(单 entry 两份);texlab 的 \ref{} 也已被 InlineCompletionService
  //   的 LaTeX 索引覆盖。这里再挂会出现三份,故不挂。
  // - markdown:marksman 暂未启用,挂了也是空。
  // - typst:tinymist 提供 <label> 引用(@fig-1/@tbl-x/@sec-)与内置函数补全。
  //   与 CiteCompletionProvider 双源并存,triggerCharacters 共享 '@';Monaco 多
  //   provider 是合并不抢,各自 filterText 自动分流:
  //     打 @fig- → tinymist 命中 label,Zotero cite 因 filterText 不匹配被 Monaco
  //                  fuzzy filter 过滤掉
  //     打 @liu → Zotero cite 命中文献,tinymist 通常无 label 匹配返空
  //   '@' 列入 trigger 是 typst 引用语法刚需;'#'/'.'/'('/','/' ' 是 typst function
  //   call / method / argument list 的通用触发集。
  monacoInstance.languages.registerCompletionItemProvider('typst', {
    triggerCharacters: ['@', '#', '.', ',', '(', ' '],
    provideCompletionItems: async (
      model: monaco.editor.ITextModel,
      position: monaco.Position
    ) => {
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
