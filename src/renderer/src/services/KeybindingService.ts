/**
 * @file KeybindingService.ts - Keybinding Management Service
 * @description Keybinding management based on command system, supporting multi-platform and context conditions
 * @depends CommandService
 */

import { Emitter, type IDisposable } from '../../../../shared/utils';
import type { CommandServiceImpl } from './CommandService';

// ====== Types ======

export interface Keybinding {
  commandId: string;
  /** Key combo (Windows/Linux format) */
  key: string;
  /** Mac-specific key combo */
  mac?: string;
  /** Context key expression for when condition */
  when?: string;
  /** Higher number = higher priority */
  priority?: number;
  description?: string;
}

interface ParsedKeybinding {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

interface KeybindingRegistration {
  keybinding: Keybinding;
  parsed: ParsedKeybinding;
}

type Platform = 'mac' | 'windows' | 'linux';

// ====== Utility Functions ======

function getPlatform(): Platform {
  if (typeof navigator !== 'undefined') {
    const platform = navigator.platform?.toLowerCase() || '';
    if (platform.includes('mac')) return 'mac';
    if (platform.includes('win')) return 'windows';
  }
  return 'linux';
}

function parseKeybinding(keyStr: string): ParsedKeybinding {
  const parts = keyStr
    .toLowerCase()
    .split('+')
    .map((s) => s.trim());

  return {
    ctrl: parts.includes('ctrl') || parts.includes('control'),
    alt: parts.includes('alt') || parts.includes('option'),
    shift: parts.includes('shift'),
    meta: parts.includes('meta') || parts.includes('cmd') || parts.includes('command'),
    key:
      parts.filter(
        (p) => !['ctrl', 'control', 'alt', 'option', 'shift', 'meta', 'cmd', 'command'].includes(p)
      )[0] || '',
  };
}

function eventToKeybinding(event: KeyboardEvent): ParsedKeybinding {
  return {
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
    key: event.key.toLowerCase(),
  };
}

function matchesKeybinding(a: ParsedKeybinding, b: ParsedKeybinding): boolean {
  return (
    a.ctrl === b.ctrl &&
    a.alt === b.alt &&
    a.shift === b.shift &&
    a.meta === b.meta &&
    normalizeKey(a.key) === normalizeKey(b.key)
  );
}

function normalizeKey(key: string): string {
  const keyMap: Record<string, string> = {
    escape: 'escape',
    esc: 'escape',
    enter: 'enter',
    return: 'enter',
    tab: 'tab',
    space: ' ',
    backspace: 'backspace',
    delete: 'delete',
    del: 'delete',
    up: 'arrowup',
    down: 'arrowdown',
    left: 'arrowleft',
    right: 'arrowright',
    arrowup: 'arrowup',
    arrowdown: 'arrowdown',
    arrowleft: 'arrowleft',
    arrowright: 'arrowright',
  };

  return keyMap[key.toLowerCase()] || key.toLowerCase();
}

function formatKeybinding(keybinding: ParsedKeybinding, platform: Platform): string {
  const parts: string[] = [];

  if (platform === 'mac') {
    if (keybinding.ctrl) parts.push('⌃');
    if (keybinding.alt) parts.push('⌥');
    if (keybinding.shift) parts.push('⇧');
    if (keybinding.meta) parts.push('⌘');
  } else {
    if (keybinding.ctrl) parts.push('Ctrl');
    if (keybinding.alt) parts.push('Alt');
    if (keybinding.shift) parts.push('Shift');
    if (keybinding.meta) parts.push('Win');
  }

  if (keybinding.key) {
    parts.push(keybinding.key.toUpperCase());
  }

  return platform === 'mac' ? parts.join('') : parts.join('+');
}

// ====== Keybinding Service Implementation ======

/**
 * Obtain via ServiceRegistry, do not instantiate directly
 */
export class KeybindingServiceImpl implements IDisposable {
  private readonly _keybindings: Map<string, KeybindingRegistration[]> = new Map();
  private readonly _context: Map<string, unknown> = new Map();
  private readonly _platform: Platform;
  private _enabled = true;
  private _keydownHandler: ((e: KeyboardEvent) => void) | null = null;

  private readonly _onDidChangeContext = new Emitter<{ key: string; value: unknown }>();
  readonly onDidChangeContext = this._onDidChangeContext.event;

  private readonly _onDidTriggerKeybinding = new Emitter<{
    keybinding: Keybinding;
    event: KeyboardEvent;
  }>();
  readonly onDidTriggerKeybinding = this._onDidTriggerKeybinding.event;

  // Lazy-loaded to avoid circular dependency
  private _commandService: CommandServiceImpl | null = null;

  constructor() {
    this._platform = getPlatform();
    this._setupEventListener();
  }

  private _getCommandService(): CommandServiceImpl {
    if (!this._commandService) {
      const { getCommandService } = require('./CommandService');
      this._commandService = getCommandService();
    }
    return this._commandService!;
  }

  private _setupEventListener(): void {
    this._keydownHandler = (event: KeyboardEvent) => {
      if (!this._enabled) return;

      // Skip input elements unless it's a global key (Ctrl/Cmd)
      const target = event.target as HTMLElement;
      const isInput =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      const isGlobalKey = event.ctrlKey || event.metaKey;

      if (isInput && !isGlobalKey) return;

      this._handleKeydown(event);
    };

    window.addEventListener('keydown', this._keydownHandler, true);
  }

  private _handleKeydown(event: KeyboardEvent): void {
    const eventKeybinding = eventToKeybinding(event);

    for (const [, registrations] of this._keybindings) {
      const sorted = [...registrations].sort(
        (a, b) => (b.keybinding.priority || 0) - (a.keybinding.priority || 0)
      );

      for (const registration of sorted) {
        if (!matchesKeybinding(eventKeybinding, registration.parsed)) {
          continue;
        }

        if (registration.keybinding.when && !this._evaluateWhen(registration.keybinding.when)) {
          continue;
        }

        event.preventDefault();
        event.stopPropagation();

        this._onDidTriggerKeybinding.fire({
          keybinding: registration.keybinding,
          event,
        });

        this._getCommandService().tryExecuteCommand(registration.keybinding.commandId);

        return;
      }
    }
  }

  /**
   * Evaluate when-clause condition expression
   * Supports: key, !key, key == value, key && key2, key || key2
   */
  private _evaluateWhen(when: string): boolean {
    try {
      if (when.includes('||')) {
        return when.split('||').some((part) => this._evaluateWhen(part.trim()));
      }

      if (when.includes('&&')) {
        return when.split('&&').every((part) => this._evaluateWhen(part.trim()));
      }

      if (when.startsWith('!')) {
        return !this._evaluateWhen(when.slice(1).trim());
      }

      if (when.includes('==')) {
        const [key, value] = when.split('==').map((s) => s.trim());
        const contextValue = this._context.get(key);
        return String(contextValue) === value.replace(/['"]/g, '');
      }

      if (when.includes('!=')) {
        const [key, value] = when.split('!=').map((s) => s.trim());
        const contextValue = this._context.get(key);
        return String(contextValue) !== value.replace(/['"]/g, '');
      }

      return !!this._context.get(when);
    } catch {
      console.warn(`[KeybindingService] Failed to evaluate when: ${when}`);
      return false;
    }
  }

  registerKeybinding(keybinding: Keybinding): IDisposable {
    const keyStr = this._platform === 'mac' && keybinding.mac ? keybinding.mac : keybinding.key;

    const parsed = parseKeybinding(keyStr);
    const registration: KeybindingRegistration = { keybinding, parsed };

    const existing = this._keybindings.get(keybinding.commandId) || [];
    existing.push(registration);
    this._keybindings.set(keybinding.commandId, existing);

    return {
      dispose: () => {
        const list = this._keybindings.get(keybinding.commandId);
        if (list) {
          const index = list.indexOf(registration);
          if (index !== -1) {
            list.splice(index, 1);
          }
          if (list.length === 0) {
            this._keybindings.delete(keybinding.commandId);
          }
        }
      },
    };
  }

  registerKeybindings(keybindings: Keybinding[]): IDisposable {
    const disposables = keybindings.map((kb) => this.registerKeybinding(kb));

    return {
      dispose: () => {
        disposables.forEach((d) => d.dispose());
      },
    };
  }

  setContext(key: string, value: unknown): void {
    const oldValue = this._context.get(key);
    if (oldValue !== value) {
      this._context.set(key, value);
      this._onDidChangeContext.fire({ key, value });
    }
  }

  getContext(key: string): unknown {
    return this._context.get(key);
  }

  deleteContext(key: string): void {
    if (this._context.has(key)) {
      this._context.delete(key);
      this._onDidChangeContext.fire({ key, value: undefined });
    }
  }

  getKeybindingForCommand(commandId: string): string | undefined {
    const registrations = this._keybindings.get(commandId);
    if (!registrations || registrations.length === 0) return undefined;

    return formatKeybinding(registrations[0].parsed, this._platform);
  }

  getAllKeybindings(): Keybinding[] {
    const result: Keybinding[] = [];
    for (const registrations of this._keybindings.values()) {
      for (const reg of registrations) {
        result.push(reg.keybinding);
      }
    }
    return result;
  }

  findConflicts(keybinding: Keybinding): Keybinding[] {
    const keyStr = this._platform === 'mac' && keybinding.mac ? keybinding.mac : keybinding.key;
    const parsed = parseKeybinding(keyStr);

    const conflicts: Keybinding[] = [];

    for (const registrations of this._keybindings.values()) {
      for (const reg of registrations) {
        if (
          matchesKeybinding(parsed, reg.parsed) &&
          reg.keybinding.commandId !== keybinding.commandId
        ) {
          conflicts.push(reg.keybinding);
        }
      }
    }

    return conflicts;
  }

  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
  }

  isEnabled(): boolean {
    return this._enabled;
  }

  getPlatform(): Platform {
    return this._platform;
  }

  dispose(): void {
    if (this._keydownHandler) {
      window.removeEventListener('keydown', this._keydownHandler, true);
      this._keydownHandler = null;
    }
    this._keybindings.clear();
    this._context.clear();
    this._onDidChangeContext.dispose();
    this._onDidTriggerKeybinding.dispose();
  }
}

// ====== Lazy Service Getter ======

let KeybindingService: KeybindingServiceImpl | null = null;

export function getKeybindingService(): KeybindingServiceImpl {
  if (!KeybindingService) {
    const { getServices } = require('./core/ServiceRegistry');
    KeybindingService = getServices().keybinding;
  }
  return KeybindingService!;
}

/** @internal Called by ServiceRegistry */
export function _setKeybindingServiceInstance(instance: KeybindingServiceImpl): void {
  KeybindingService = instance;
}

// ====== Context Keys ======

export const ContextKeys = {
  EDITOR_FOCUS: 'editorFocus',
  EDITOR_TEXT_FOCUS: 'editorTextFocus',
  INPUT_FOCUS: 'inputFocus',
  SIDEBAR_VISIBLE: 'sidebarVisible',
  PREVIEW_VISIBLE: 'previewVisible',
  PALETTE_OPEN: 'paletteOpen',
  HAS_OPEN_FILE: 'hasOpenFile',
  HAS_PROJECT: 'hasProject',
  IS_COMPILING: 'isCompiling',
  AI_GENERATING: 'aiGenerating',
} as const;

// ====== React Hooks ======

import { useEffect } from 'react';

export function useKeybinding(keybinding: Keybinding, deps: React.DependencyList = []): void {
  useEffect(() => {
    const disposable = getKeybindingService().registerKeybinding(keybinding);
    return () => disposable.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function useContextKey(key: string, value: unknown): void {
  useEffect(() => {
    getKeybindingService().setContext(key, value);
    return () => {
      getKeybindingService().deleteContext(key);
    };
  }, [key, value]);
}
