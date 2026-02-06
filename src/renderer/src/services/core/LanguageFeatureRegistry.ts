/**
 * @file LanguageFeatureRegistry.ts - Language Feature Registry
 * @description Supports dynamic registration of compilers and LSP Providers, eliminates hardcoded branches
 * @depends shared/utils (Emitter, Event)
 */

import {
  DisposableStore,
  Emitter,
  type Event,
  type IDisposable,
} from '../../../../../shared/utils';
import type { EditorTab } from '../../types';
import type { CompileResult } from './CompileService';

// ====== Type Definitions ======

export interface CompilerOptions {
  engine?: string;
  mainFile?: string;
  projectPath?: string;
  overleaf?: {
    serverUrl: string;
    projectId: string;
    email?: string;
    cookies?: string;
    remoteCompiler?: string;
  };
  activeTab?: EditorTab;
}

export interface CompilerProvider {
  readonly id: string;
  readonly name: string;
  readonly supportedExtensions: string[];
  readonly priority?: number;
  readonly isRemote?: boolean;

  compile(filePath: string, content: string, options: CompilerOptions): Promise<CompileResult>;

  canHandle?(filePath: string, options?: CompilerOptions): boolean;
}

interface ProviderEntry<T> {
  provider: T;
  priority: number;
  timestamp: number;
}

// ====== LanguageFeatureRegistry Implementation ======

export class LanguageFeatureRegistry<T extends { id: string }> implements IDisposable {
  private readonly _disposables = new DisposableStore();
  private readonly _entries: ProviderEntry<T>[] = [];
  private _clock = 0;

  private readonly _onDidChange = new Emitter<void>();
  readonly onDidChange: Event<void> = this._onDidChange.event;

  constructor() {
    this._disposables.add(this._onDidChange);
  }

  register(provider: T, priority = 0): IDisposable {
    const existingIndex = this._entries.findIndex((e) => e.provider.id === provider.id);
    if (existingIndex >= 0) {
      console.warn(
        `[LanguageFeatureRegistry] Provider "${provider.id}" already registered, replacing.`
      );
      this._entries.splice(existingIndex, 1);
    }

    const entry: ProviderEntry<T> = {
      provider,
      priority,
      timestamp: this._clock++,
    };

    this._entries.push(entry);
    this._onDidChange.fire();

    return {
      dispose: () => {
        const idx = this._entries.findIndex((e) => e.provider === provider);
        if (idx >= 0) {
          this._entries.splice(idx, 1);
          this._onDidChange.fire();
        }
      },
    };
  }

  getAll(): T[] {
    return this._entries
      .slice()
      .sort((a, b) => {
        if (b.priority !== a.priority) {
          return b.priority - a.priority;
        }
        return b.timestamp - a.timestamp;
      })
      .map((e) => e.provider);
  }

  get(id: string): T | undefined {
    return this._entries.find((e) => e.provider.id === id)?.provider;
  }

  has(id: string): boolean {
    return this._entries.some((e) => e.provider.id === id);
  }

  get size(): number {
    return this._entries.length;
  }

  dispose(): void {
    this._entries.length = 0;
    this._disposables.dispose();
  }
}

// ====== CompilerRegistry Specialized Implementation ======

export class CompilerRegistry extends LanguageFeatureRegistry<CompilerProvider> {
  getCompilerForFile(filePath: string, options?: CompilerOptions): CompilerProvider | undefined {
    const ext = this._getExtension(filePath);
    const providers = this.getAll();

    for (const provider of providers) {
      if (provider.canHandle) {
        if (provider.canHandle(filePath, options)) {
          return provider;
        }
        continue;
      }

      if (provider.supportedExtensions.includes(ext)) {
        return provider;
      }
    }

    return undefined;
  }

  getCompilersForFile(filePath: string, options?: CompilerOptions): CompilerProvider[] {
    const ext = this._getExtension(filePath);
    const providers = this.getAll();

    return providers.filter((provider) => {
      if (provider.canHandle) {
        return provider.canHandle(filePath, options);
      }
      return provider.supportedExtensions.includes(ext);
    });
  }

  private _getExtension(filePath: string): string {
    const lastDot = filePath.lastIndexOf('.');
    if (lastDot < 0) return '';
    return filePath.slice(lastDot + 1).toLowerCase();
  }
}

// ====== Lazy Service Getter ======

let _compilerRegistry: CompilerRegistry | null = null;

export function getCompilerRegistry(): CompilerRegistry {
  if (!_compilerRegistry) {
    const { getServices } = require('./ServiceRegistry');
    _compilerRegistry = getServices().compiler;
  }
  return _compilerRegistry!;
}

export function _setCompilerRegistryInstance(instance: CompilerRegistry): void {
  _compilerRegistry = instance;
}
