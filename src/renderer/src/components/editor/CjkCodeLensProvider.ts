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
import { insertCjkSupport, shouldOfferCjkSupport } from '../../services/cjkSupport';
import { saveActiveFile } from './hooks/editorSetup';

const logger = createLogger('CjkCodeLens');

/**
 * Registered once per Monaco instance. The command handler resolves the model
 * from the CodeLens argument (not a captured editor), so it stays correct even
 * if the editor is remounted.
 */
let registered = false;

export function registerCjkCodeLensProvider(
  monacoInstance: Monaco,
  editor: monaco.editor.IStandaloneCodeEditor
): void {
  if (registered) return;
  registered = true;

  // `addCommand` needs an editor to mint a command id, but the handler below
  // does not depend on that editor instance — it operates on the model passed
  // via the lens argument and persists through the shared save flow.
  const commandId = editor.addCommand(0, (_ctx: unknown, uri?: string) => {
    const model = uri
      ? monacoInstance.editor.getModel(monacoInstance.Uri.parse(uri))
      : editor.getModel();
    if (!model) return;

    const result = insertCjkSupport(model.getValue());
    if (!result) return;

    // Single full-range replace: one undo step, and the content-change tracker
    // marks the tab dirty so the save below actually writes to disk.
    model.pushEditOperations(
      null,
      [{ range: model.getFullModelRange(), text: result.source }],
      () => null
    );

    void saveActiveFile();
    logger.info('Inserted standard CJK support', { line: result.line });
  }) as string | null;

  const disposable = monacoInstance.languages.registerCodeLensProvider('latex', {
    provideCodeLenses(model: monaco.editor.ITextModel) {
      if (!commandId || !shouldOfferCjkSupport(model.getValue())) {
        return { lenses: [], dispose() {} };
      }

      // Anchor the lens on the \documentclass line.
      const match = model.findMatches(
        '\\documentclass',
        false, // searchOnlyEditableRange
        false, // isRegex
        false, // matchCase
        null, // wordSeparators
        false, // captureMatches
        1 // limit
      )[0];
      const line = match ? match.range.startLineNumber : 1;

      return {
        lenses: [
          {
            range: new monacoInstance.Range(line, 1, line, 1),
            id: 'scipen-cjk-support',
            command: {
              id: commandId,
              title: t('cjk.addSupport'),
              arguments: [model.uri.toString()],
            },
          },
        ],
        dispose() {},
      };
    },
    resolveCodeLens(_model: monaco.editor.ITextModel, lens: monaco.languages.CodeLens) {
      return lens;
    },
  });

  // Provider lives for the app lifetime (single Monaco instance); we don't
  // hold the disposable because there's no unregister path, matching how the
  // cite/inline providers are registered.
  void disposable;
}
