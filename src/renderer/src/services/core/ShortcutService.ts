/**
 * @file ShortcutService.ts - Shortcut Management Service
 * @description Parses shortcut strings and manages Monaco editor shortcut bindings
 * @depends Monaco Editor, SettingsService
 */

import type { Monaco } from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import { Disposable, Emitter } from '../../../../../shared/utils';
import type { AppSettings } from '../../types';

// ====== Type Definitions ======

export type ShortcutAction =
  | 'save'
  | 'compile'
  | 'commandPalette'
  | 'aiPolish'
  | 'aiChat'
  | 'togglePreview'
  | 'newWindow';

export interface ShortcutBinding {
  action: ShortcutAction;
  keybinding: number; // Monaco keybinding (KeyMod | KeyCode)
  handler: () => void | Promise<void>;
}

export interface ParsedKey {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  key: string;
}

// ====== Key Name Mapping Table ======

/**
 * Maps common key names to Monaco KeyCode (lowercase for case-insensitive matching)
 * Note: Monaco's KeyCode is an enum, requires dynamic access
 */
const KEY_MAP: Record<string, string> = {
  a: 'KeyA',
  b: 'KeyB',
  c: 'KeyC',
  d: 'KeyD',
  e: 'KeyE',
  f: 'KeyF',
  g: 'KeyG',
  h: 'KeyH',
  i: 'KeyI',
  j: 'KeyJ',
  k: 'KeyK',
  l: 'KeyL',
  m: 'KeyM',
  n: 'KeyN',
  o: 'KeyO',
  p: 'KeyP',
  q: 'KeyQ',
  r: 'KeyR',
  s: 'KeyS',
  t: 'KeyT',
  u: 'KeyU',
  v: 'KeyV',
  w: 'KeyW',
  x: 'KeyX',
  y: 'KeyY',
  z: 'KeyZ',
  '0': 'Digit0',
  '1': 'Digit1',
  '2': 'Digit2',
  '3': 'Digit3',
  '4': 'Digit4',
  '5': 'Digit5',
  '6': 'Digit6',
  '7': 'Digit7',
  '8': 'Digit8',
  '9': 'Digit9',
  f1: 'F1',
  f2: 'F2',
  f3: 'F3',
  f4: 'F4',
  f5: 'F5',
  f6: 'F6',
  f7: 'F7',
  f8: 'F8',
  f9: 'F9',
  f10: 'F10',
  f11: 'F11',
  f12: 'F12',
  enter: 'Enter',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  tab: 'Tab',
  space: 'Space',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  ins: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  up: 'UpArrow',
  down: 'DownArrow',
  left: 'LeftArrow',
  right: 'RightArrow',
  arrowup: 'UpArrow',
  arrowdown: 'DownArrow',
  arrowleft: 'LeftArrow',
  arrowright: 'RightArrow',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  '\\': 'Backslash',
  ';': 'Semicolon',
  "'": 'Quote',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '-': 'Minus',
  '=': 'Equal',
  '`': 'Backquote',
};

// ====== Parsing Utility Functions ======

function capitalizeFirst(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Parse shortcut string
 * @example "Ctrl+Shift+S" -> { ctrl: true, shift: true, alt: false, meta: false, key: "s" }
 *
 * Note: key is stored lowercase to match KEY_MAP (which uses lowercase key names)
 */
export function parseShortcutString(shortcut: string): ParsedKey | null {
  if (!shortcut || typeof shortcut !== 'string') return null;

  const parts = shortcut.split('+').map((p) => p.trim());
  const result: ParsedKey = {
    ctrl: false,
    shift: false,
    alt: false,
    meta: false,
    key: '',
  };

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') {
      result.ctrl = true;
    } else if (lower === 'shift') {
      result.shift = true;
    } else if (lower === 'alt') {
      result.alt = true;
    } else if (lower === 'meta' || lower === 'cmd' || lower === 'command' || lower === 'win') {
      result.meta = true;
    } else {
      result.key = lower;
    }
  }

  if (!result.key) return null;
  return result;
}

/**
 * Convert parsed shortcut to Monaco keybinding value
 */
export function toMonacoKeybinding(parsed: ParsedKey, monacoInstance: Monaco): number | null {
  const keyCodeName = KEY_MAP[parsed.key];
  if (!keyCodeName) {
    console.warn(`[ShortcutService] Unknown key name: ${parsed.key}`);
    return null;
  }

  const keyCode = monacoInstance.KeyCode[keyCodeName as keyof typeof monacoInstance.KeyCode];
  if (keyCode === undefined) {
    console.warn(`[ShortcutService] Monaco does not support key: ${keyCodeName}`);
    return null;
  }

  let keybinding = keyCode as number;

  // Use CtrlCmd for cross-platform compatibility (Cmd on macOS, Ctrl on Windows/Linux)
  if (parsed.ctrl || parsed.meta) {
    keybinding |= monacoInstance.KeyMod.CtrlCmd;
  }
  if (parsed.shift) {
    keybinding |= monacoInstance.KeyMod.Shift;
  }
  if (parsed.alt) {
    keybinding |= monacoInstance.KeyMod.Alt;
  }

  return keybinding;
}

/**
 * Convert shortcut string directly to Monaco keybinding
 */
export function parseToMonacoKeybinding(shortcut: string, monacoInstance: Monaco): number | null {
  const parsed = parseShortcutString(shortcut);
  if (!parsed) return null;
  return toMonacoKeybinding(parsed, monacoInstance);
}

/**
 * Validate shortcut string format
 */
export function isValidShortcut(shortcut: string): boolean {
  const parsed = parseShortcutString(shortcut);
  if (!parsed) return false;
  return !!KEY_MAP[parsed.key];
}

/**
 * Normalize shortcut string format
 * @example "ctrl+shift+s" -> "Ctrl+Shift+S"
 */
export function normalizeShortcut(shortcut: string): string {
  const parsed = parseShortcutString(shortcut);
  if (!parsed) return shortcut;

  const parts: string[] = [];
  if (parsed.ctrl) parts.push('Ctrl');
  if (parsed.shift) parts.push('Shift');
  if (parsed.alt) parts.push('Alt');
  if (parsed.meta) parts.push('Meta');

  const displayKey =
    parsed.key.length === 1 ? parsed.key.toUpperCase() : capitalizeFirst(parsed.key);
  parts.push(displayKey);

  return parts.join('+');
}

// ====== Service Implementation ======

type Editor = monaco.editor.IStandaloneCodeEditor;

export class ShortcutService extends Disposable {
  private static _instance: ShortcutService | null = null;

  private _monaco: Monaco | null = null;
  private _editor: Editor | null = null;

  // Use IDisposable from addAction to manage shortcut lifecycle
  private _actionDisposables: monaco.IDisposable[] = [];

  private readonly _onShortcutTriggered = this._register(new Emitter<ShortcutAction>());
  readonly onShortcutTriggered = this._onShortcutTriggered.event;

  private _handlers = new Map<ShortcutAction, () => void | Promise<void>>();

  private constructor() {
    super();
  }

  static getInstance(): ShortcutService {
    if (!ShortcutService._instance) {
      ShortcutService._instance = new ShortcutService();
    }
    return ShortcutService._instance;
  }

  initialize(monacoInstance: Monaco, editor: Editor): void {
    this._monaco = monacoInstance;
    this._editor = editor;
  }

  registerHandler(action: ShortcutAction, handler: () => void | Promise<void>): void {
    this._handlers.set(action, handler);
  }

  private _clearActions(): void {
    for (const disposable of this._actionDisposables) {
      disposable.dispose();
    }
    this._actionDisposables = [];
  }

  /**
   * Register all shortcuts from settings
   *
   * Uses addAction instead of addCommand to:
   * 1. Get IDisposable for proper cleanup
   * 2. Release old bindings on shortcut change, avoiding "ghost shortcuts"
   */
  registerShortcuts(shortcuts: AppSettings['shortcuts']): void {
    if (!this._monaco || !this._editor) {
      console.warn('[ShortcutService] Service not initialized, cannot register shortcuts');
      return;
    }

    this._clearActions();

    const entries: [ShortcutAction, string][] = [
      ['save', shortcuts.save],
      ['compile', shortcuts.compile],
      ['commandPalette', shortcuts.commandPalette],
      ['aiPolish', shortcuts.aiPolish],
      ['aiChat', shortcuts.aiChat],
      ['togglePreview', shortcuts.togglePreview],
      ['newWindow', shortcuts.newWindow],
    ];

    for (const [action, shortcutStr] of entries) {
      const keybinding = parseToMonacoKeybinding(shortcutStr, this._monaco);
      if (keybinding === null) {
        console.warn(`[ShortcutService] Cannot parse shortcut: ${action} = "${shortcutStr}"`);
        continue;
      }

      const handler = this._handlers.get(action);
      if (!handler) {
        continue;
      }

      const disposable = this._editor.addAction({
        id: `scipen.shortcut.${action}`,
        label: `SciPen: ${action}`,
        keybindings: [keybinding],
        keybindingContext: undefined,
        contextMenuGroupId: undefined,
        run: () => {
          this._onShortcutTriggered.fire(action);
          handler();
        },
      });

      this._actionDisposables.push(disposable);
    }
  }

  /**
   * Update single shortcut
   * @deprecated Use registerShortcuts to batch update shortcuts
   */
  updateShortcut(
    action: ShortcutAction,
    _shortcutStr: string,
    handler?: () => void | Promise<void>
  ): boolean {
    if (handler) {
      this._handlers.set(action, handler);
    }

    // addAction cannot update individually, must re-register all shortcuts
    console.warn(
      '[ShortcutService] updateShortcut is deprecated, use registerShortcuts to batch update shortcuts'
    );
    return true;
  }

  override dispose(): void {
    this._clearActions();
    this._handlers.clear();
    ShortcutService._instance = null;
    super.dispose();
  }
}

// ====== Export Singleton Getter Function ======

export function getShortcutService(): ShortcutService {
  return ShortcutService.getInstance();
}
