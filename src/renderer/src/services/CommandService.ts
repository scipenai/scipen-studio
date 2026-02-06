/**
 * @file CommandService.ts - Command Registry
 * @description Unified management of user operations, supports keybinding and command palette
 * @depends shared/utils (Emitter, IDisposable)
 */

import { Emitter, type IDisposable } from '../../../../shared/utils';

// ====== Types ======

export type CommandHandler = (...args: unknown[]) => unknown | Promise<unknown>;

export interface CommandMetadata {
  id: string;
  title?: string;
  category?: string;
  icon?: string;
  description?: string;
  showInPalette?: boolean;
}

interface CommandRegistration {
  metadata: CommandMetadata;
  handler: CommandHandler;
}

export interface CommandExecutionEvent {
  commandId: string;
  args: unknown[];
  startTime: number;
  endTime?: number;
  error?: Error;
}

// ====== Command Service Implementation ======

/**
 * Obtain via ServiceRegistry, do not instantiate directly
 */
export class CommandServiceImpl implements IDisposable {
  private readonly _commands: Map<string, CommandRegistration> = new Map();

  private readonly _onWillExecuteCommand = new Emitter<{ commandId: string; args: unknown[] }>();
  readonly onWillExecuteCommand = this._onWillExecuteCommand.event;

  private readonly _onDidExecuteCommand = new Emitter<CommandExecutionEvent>();
  readonly onDidExecuteCommand = this._onDidExecuteCommand.event;

  registerCommand(idOrMetadata: string | CommandMetadata, handler: CommandHandler): IDisposable {
    const metadata: CommandMetadata =
      typeof idOrMetadata === 'string' ? { id: idOrMetadata } : idOrMetadata;

    if (this._commands.has(metadata.id)) {
      console.warn(`[CommandService] Command "${metadata.id}" is already registered, overwriting.`);
    }

    this._commands.set(metadata.id, { metadata, handler });

    return {
      dispose: () => {
        this._commands.delete(metadata.id);
      },
    };
  }

  registerCommands(
    commands: Array<{ metadata: CommandMetadata; handler: CommandHandler }>
  ): IDisposable {
    const disposables = commands.map(({ metadata, handler }) =>
      this.registerCommand(metadata, handler)
    );

    return {
      dispose: () => {
        disposables.forEach((d) => d.dispose());
      },
    };
  }

  /**
   * Execute a command by ID
   * @throws {Error} When command not found
   */
  async executeCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T> {
    const registration = this._commands.get(id);

    if (!registration) {
      throw new Error(`[CommandService] Command not found: ${id}`);
    }

    const startTime = performance.now();

    this._onWillExecuteCommand.fire({ commandId: id, args });

    try {
      const result = await registration.handler(...args);

      const endTime = performance.now();

      this._onDidExecuteCommand.fire({
        commandId: id,
        args,
        startTime,
        endTime,
      });

      return result as T;
    } catch (error) {
      const endTime = performance.now();

      this._onDidExecuteCommand.fire({
        commandId: id,
        args,
        startTime,
        endTime,
        error: error instanceof Error ? error : new Error(String(error)),
      });

      throw error;
    }
  }

  /**
   * Execute command without throwing (logs errors instead)
   */
  async tryExecuteCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T | undefined> {
    try {
      return await this.executeCommand<T>(id, ...args);
    } catch (error) {
      console.error(`[CommandService] Failed to execute command "${id}":`, error);
      return undefined;
    }
  }

  hasCommand(id: string): boolean {
    return this._commands.has(id);
  }

  getCommand(id: string): CommandMetadata | undefined {
    return this._commands.get(id)?.metadata;
  }

  getCommands(): CommandMetadata[] {
    return Array.from(this._commands.values()).map((r) => r.metadata);
  }

  getPaletteCommands(): CommandMetadata[] {
    return this.getCommands().filter((cmd) => cmd.showInPalette !== false);
  }

  getCommandsByCategory(): Map<string, CommandMetadata[]> {
    const result = new Map<string, CommandMetadata[]>();

    for (const { metadata } of this._commands.values()) {
      const category = metadata.category || 'General';
      const list = result.get(category) || [];
      list.push(metadata);
      result.set(category, list);
    }

    return result;
  }

  searchCommands(query: string): CommandMetadata[] {
    const lowerQuery = query.toLowerCase();

    return this.getPaletteCommands().filter((cmd) => {
      const searchText = [cmd.id, cmd.title, cmd.category, cmd.description]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return searchText.includes(lowerQuery);
    });
  }

  dispose(): void {
    this._commands.clear();
    this._onWillExecuteCommand.dispose();
    this._onDidExecuteCommand.dispose();
  }
}

// ====== Built-in Command IDs ======

export const Commands = {
  FILE_OPEN: 'file.open',
  FILE_SAVE: 'file.save',
  FILE_SAVE_ALL: 'file.saveAll',
  FILE_CLOSE: 'file.close',
  FILE_NEW: 'file.new',
  FILE_DELETE: 'file.delete',
  FILE_RENAME: 'file.rename',

  EDIT_UNDO: 'edit.undo',
  EDIT_REDO: 'edit.redo',
  EDIT_CUT: 'edit.cut',
  EDIT_COPY: 'edit.copy',
  EDIT_PASTE: 'edit.paste',
  EDIT_SELECT_ALL: 'edit.selectAll',
  EDIT_FIND: 'edit.find',
  EDIT_REPLACE: 'edit.replace',
  EDIT_FORMAT: 'edit.format',

  COMPILE_BUILD: 'compile.build',
  COMPILE_CLEAN: 'compile.clean',
  COMPILE_STOP: 'compile.stop',

  VIEW_TOGGLE_SIDEBAR: 'view.toggleSidebar',
  VIEW_TOGGLE_PREVIEW: 'view.togglePreview',
  VIEW_TOGGLE_TERMINAL: 'view.toggleTerminal',
  VIEW_ZOOM_IN: 'view.zoomIn',
  VIEW_ZOOM_OUT: 'view.zoomOut',
  VIEW_ZOOM_RESET: 'view.zoomReset',

  GOTO_LINE: 'goto.line',
  GOTO_DEFINITION: 'goto.definition',
  GOTO_REFERENCES: 'goto.references',
  GOTO_SYMBOL: 'goto.symbol',

  PALETTE_OPEN: 'palette.open',
  PALETTE_QUICK_OPEN: 'palette.quickOpen',

  AI_CHAT: 'ai.chat',
  AI_POLISH: 'ai.polish',
  AI_COMPLETE: 'ai.complete',
  AI_REVIEW: 'ai.review',

  KNOWLEDGE_SEARCH: 'knowledge.search',
  KNOWLEDGE_ADD: 'knowledge.add',

  SETTINGS_OPEN: 'settings.open',
  SETTINGS_KEYBOARD: 'settings.keyboard',

  WINDOW_NEW: 'window.new',
  WINDOW_CLOSE: 'window.close',
  WINDOW_RELOAD: 'window.reload',
  WINDOW_TOGGLE_DEVTOOLS: 'window.toggleDevTools',
} as const;

export type CommandId = (typeof Commands)[keyof typeof Commands];

// ====== React Hooks ======

import { useCallback, useEffect } from 'react';

// Lazy import to avoid circular dependency
let CommandService: CommandServiceImpl | null = null;

export function getCommandService(): CommandServiceImpl {
  if (!CommandService) {
    const { getServices } = require('./core/ServiceRegistry');
    CommandService = getServices().command;
  }
  return CommandService!;
}

/** @internal Called by ServiceRegistry */
export function _setCommandServiceInstance(instance: CommandServiceImpl): void {
  CommandService = instance;
}

export function useCommand(
  idOrMetadata: string | CommandMetadata,
  handler: CommandHandler,
  deps: React.DependencyList = []
): void {
  useEffect(() => {
    const disposable = getCommandService().registerCommand(idOrMetadata, handler);
    return () => disposable.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function useCommandExecutor() {
  return useCallback(<T = unknown>(id: string, ...args: unknown[]): Promise<T> => {
    return getCommandService().executeCommand<T>(id, ...args);
  }, []);
}
