/**
 * @file CjkCodeLensProvider.ts — inline "add Chinese support" CodeLens
 * @description When a LaTeX document contains Chinese characters but doesn't
 *              set up any CJK package, this shows a one-click CodeLens above
 *              `\documentclass` that inserts a standard, portable
 *              `\usepackage[fontset=fandol]{ctex}` into the *real* on-disk
 *              source.
 *
 *              This replaces the old silent per-compile injection of a private
 *              `scipencjk` package: nothing is hidden, the edit is visible and
 *              persisted, and the resulting document compiles unchanged on any
 *              standard LaTeX toolchain. See services/cjkSupport.ts.
 */

import type { Monaco } from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import { t } from '../../locales';
import { createLogger } from '../../services/LogService';
import {
  documentClassOffset,
  insertCjkSupport,
  shouldOfferCjkSupport,
} from '../../services/cjkSupport';
import { saveActiveFile } from './hooks/editorSetup';

const logger = createLogger('CjkCodeLens');

// The provider is registered once on the (single) Monaco languages service, but
// the command must be re-minted on every editor mount: `editor.addCommand` ties
// the command to that editor instance, so a captured id dies when the editor is
// disposed (React StrictMode double-mount, or any EditorPane remount). We keep
// the *current* editor + command id in module refs the once-registered provider
// reads live, so the lens always dispatches to a live command on the live editor.
let providerRegistered = false;
let activeEditor: monaco.editor.IStandaloneCodeEditor | null = null;
let commandId: string | null = null;

export function registerCjkCodeLensProvider(
  monacoInstance: Monaco,
  editor: monaco.editor.IStandaloneCodeEditor
): void {
  // Point at the current editor and mint a fresh command every mount.
  activeEditor = editor;
  commandId = editor.addCommand(0, () => applyCjkSupport()) as string | null;

  if (providerRegistered) return;
  providerRegistered = true;

  monacoInstance.languages.registerCodeLensProvider('latex', {
    provideCodeLenses(model: monaco.editor.ITextModel) {
      const source = model.getValue();
      if (!commandId || !shouldOfferCjkSupport(source)) {
        return { lenses: [], dispose() {} };
      }

      // Anchor via the SAME \documentclass regex the insertion uses, so the lens
      // always renders on the exact line the edit will land on (a plain substring
      // search could match `\documentclassfoo` or a partial token elsewhere).
      const offset = documentClassOffset(source);
      const line = offset === null ? 1 : model.getPositionAt(offset).lineNumber;

      return {
        lenses: [
          {
            range: new monacoInstance.Range(line, 1, line, 1),
            id: 'scipen-cjk-support',
            command: { id: commandId, title: t('cjk.addSupport') },
          },
        ],
        dispose() {},
      };
    },
    resolveCodeLens(_model: monaco.editor.ITextModel, lens: monaco.languages.CodeLens) {
      return lens;
    },
  });
}

/**
 * Insert standard CJK support into the active editor's document and persist it.
 * Editing and saving both go through the active editor / active tab so they
 * always target the same document.
 */
function applyCjkSupport(): void {
  const editor = activeEditor;
  const model = editor?.getModel();
  if (!editor || !model) return;

  const result = insertCjkSupport(model.getValue());
  if (!result) return;

  // Single full-range replace via the editor: one undo step, and the
  // content-change tracker marks the tab dirty so the save writes to disk.
  editor.executeEdits('cjk-support', [{ range: model.getFullModelRange(), text: result.source }]);
  editor.revealLineInCenter(result.line);
  void saveActiveFile();
  logger.info('Inserted standard CJK support', { line: result.line });
}
