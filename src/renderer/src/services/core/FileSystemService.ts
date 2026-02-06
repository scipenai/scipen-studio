/**
 * @file FileSystemService.ts - File System Abstraction Layer
 * @description Provides unified file operation interface, supports IPC in production and Mock in test environment
 * @depends IPC (api.file)
 */

// ============ Interface Definitions ============

import { api } from '../../api';

export interface IFileSystem {
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string | null>;
  pathExists(path: string): Promise<boolean>;
  deleteFile(path: string): Promise<void>;
  ensureDir(path: string): Promise<void>;
}

// ====== Electron Implementation ======

export class ElectronFileSystem implements IFileSystem {
  async writeFile(path: string, content: string): Promise<void> {
    await api.file.write(path, content);
  }

  async readFile(path: string): Promise<string | null> {
    const result = await api.file.read(path);
    return result?.content ?? null;
  }

  async pathExists(path: string): Promise<boolean> {
    return (await api.file.exists(path)) ?? false;
  }

  async deleteFile(path: string): Promise<void> {
    await api.file.delete(path);
  }

  async ensureDir(path: string): Promise<void> {
    await api.file.createFolder(path);
  }
}

// ====== Mock Implementation (for testing) ======

export class MockFileSystem implements IFileSystem {
  private files = new Map<string, string>();
  private directories = new Set<string>();

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async readFile(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async pathExists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }

  async deleteFile(path: string): Promise<void> {
    this.files.delete(path);
  }

  async ensureDir(path: string): Promise<void> {
    this.directories.add(path);
  }

  // ====== Test Helper Methods ======

  clear(): void {
    this.files.clear();
    this.directories.clear();
  }

  getAllFiles(): string[] {
    return Array.from(this.files.keys());
  }

  getFileContent(path: string): string | undefined {
    return this.files.get(path);
  }
}

// ====== Singleton Instance ======

let FileSystem: IFileSystem | null = null;

export function getFileSystem(): IFileSystem {
  if (!FileSystem) {
    FileSystem = new ElectronFileSystem();
  }
  return FileSystem;
}

export function _setFileSystemInstance(instance: IFileSystem): void {
  FileSystem = instance;
}

export function _resetFileSystemInstance(): void {
  FileSystem = null;
}
