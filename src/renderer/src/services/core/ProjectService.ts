/**
 * @file ProjectService.ts - Project Management Service
 * @description Event-driven project management, including project paths, file trees, and knowledge base
 * @depends IPC (api.file), shared/utils (Emitter)
 */

import {
  DisposableStore,
  Emitter,
  type Event,
  type IDisposable,
  IdleValue,
} from '../../../../../shared/utils';
import { api } from '../../api';
import type { FileNode, KnowledgeBase } from '../../types';
import { createLogger } from '../LogService';

const logger = createLogger('ProjectService');

// ====== File Tree Statistics (Lazy Loading) ======
//
// Advantages of using IdleValue:
// 1. File tree stats computed during CPU idle time, doesn't block first screen render
// 2. If UI needs immediate access, can get immediately (will compute synchronously)
// 3. For large projects (1000+ files), saves hundreds of milliseconds at startup
//

export interface FileTreeStats {
  totalFiles: number;
  totalFolders: number;
  byExtension: Map<string, number>;
  latexFiles: number;
  typstFiles: number;
  computedAt: number;
}

function computeFileTreeStats(tree: FileNode | null): FileTreeStats {
  const stats: FileTreeStats = {
    totalFiles: 0,
    totalFolders: 0,
    byExtension: new Map(),
    latexFiles: 0,
    typstFiles: 0,
    computedAt: Date.now(),
  };

  if (!tree) return stats;

  const traverse = (node: FileNode) => {
    if (node.type === 'directory') {
      stats.totalFolders++;
      node.children?.forEach(traverse);
    } else {
      stats.totalFiles++;
      const ext = node.name.split('.').pop()?.toLowerCase() || '';
      stats.byExtension.set(ext, (stats.byExtension.get(ext) || 0) + 1);

      if (['tex', 'latex', 'bib', 'sty', 'cls'].includes(ext)) {
        stats.latexFiles++;
      }
      if (['typ'].includes(ext)) {
        stats.typstFiles++;
      }
    }
  };

  traverse(tree);
  return stats;
}

// ====== Type Definitions ======

export interface FileConflict {
  path: string;
  type: 'change' | 'unlink';
  hasUnsavedChanges: boolean;
}

export interface ProjectChangeEvent {
  readonly path: string | null;
  readonly fileTree: FileNode | null;
}

export interface FileChangeDelta {
  type: 'add' | 'unlink' | 'change';
  path: string;
}

// ====== ProjectService Implementation ======

export class ProjectService implements IDisposable {
  private static _instance: ProjectService | null = null;
  private readonly _disposables = new DisposableStore();

  static getInstance(): ProjectService {
    if (!ProjectService._instance) {
      ProjectService._instance = new ProjectService();
    }
    return ProjectService._instance;
  }

  private _projectPath: string | null = null;
  private _fileTree: FileNode | null = null;
  private _knowledgeBases: KnowledgeBase[] = [];
  private _selectedKnowledgeBaseId: string | null = null;
  private _completionKnowledgeBaseId: string | null = null;
  private _fileConflict: FileConflict | null = null;

  // ====== File Path Index (for @ completion) ======
  //
  // Flat path list separate from fileTree, specifically for search/completion.
  // Advantages:
  // 1. Doesn't depend on fileTree lazy loading state
  // 2. Built silently in background, doesn't block UI
  // 3. Low memory usage (only stores strings)
  //
  private _filePathIndex: string[] = [];
  private _isIndexing = false;
  private _indexingProjectPath: string | null = null;

  /**
   * File tree stats - computed using IdleValue during CPU idle time
   *
   * This is a lazy-loaded value:
   * - When file tree updates, creates new IdleValue
   * - Stats computation executes in requestIdleCallback
   * - If UI needs immediate access, computes synchronously
   *
   * For large projects, saves computation overhead at startup
   */
  private _fileTreeStats: IdleValue<FileTreeStats> | null = null;

  // ====== Event Definitions ======

  private readonly _onDidChangeProject = new Emitter<ProjectChangeEvent>();
  readonly onDidChangeProject: Event<ProjectChangeEvent> = this._onDidChangeProject.event;

  private readonly _onDidChangeFileTree = new Emitter<FileNode | null>();
  readonly onDidChangeFileTree: Event<FileNode | null> = this._onDidChangeFileTree.event;

  private readonly _onDidChangeKnowledgeBases = new Emitter<KnowledgeBase[]>();
  readonly onDidChangeKnowledgeBases: Event<KnowledgeBase[]> =
    this._onDidChangeKnowledgeBases.event;

  private readonly _onDidChangeSelectedKB = new Emitter<string | null>();
  readonly onDidChangeSelectedKB: Event<string | null> = this._onDidChangeSelectedKB.event;

  private readonly _onDidChangeCompletionKB = new Emitter<string | null>();
  readonly onDidChangeCompletionKB: Event<string | null> = this._onDidChangeCompletionKB.event;

  private readonly _onDidChangeFileConflict = new Emitter<FileConflict | null>();
  readonly onDidChangeFileConflict: Event<FileConflict | null> =
    this._onDidChangeFileConflict.event;

  private readonly _onDidChangeFilePathIndex = new Emitter<string[]>();
  readonly onDidChangeFilePathIndex: Event<string[]> = this._onDidChangeFilePathIndex.event;

  private readonly _onDidChangeIndexingState = new Emitter<boolean>();
  readonly onDidChangeIndexingState: Event<boolean> = this._onDidChangeIndexingState.event;

  constructor() {
    this._disposables.add(this._onDidChangeProject);
    this._disposables.add(this._onDidChangeFileTree);
    this._disposables.add(this._onDidChangeKnowledgeBases);
    this._disposables.add(this._onDidChangeSelectedKB);
    this._disposables.add(this._onDidChangeCompletionKB);
    this._disposables.add(this._onDidChangeFileConflict);
    this._disposables.add(this._onDidChangeFilePathIndex);
    this._disposables.add(this._onDidChangeIndexingState);
  }

  // ====== Getters ======

  get projectPath(): string | null {
    return this._projectPath;
  }

  get fileTree(): FileNode | null {
    return this._fileTree;
  }

  get knowledgeBases(): KnowledgeBase[] {
    return this._knowledgeBases;
  }

  get selectedKnowledgeBaseId(): string | null {
    return this._selectedKnowledgeBaseId;
  }

  get completionKnowledgeBaseId(): string | null {
    return this._completionKnowledgeBaseId;
  }

  get fileConflict(): FileConflict | null {
    return this._fileConflict;
  }

  get filePathIndex(): string[] {
    return this._filePathIndex;
  }

  get isIndexing(): boolean {
    return this._isIndexing;
  }

  /**
   * Get file tree statistics
   *
   * Uses IdleValue for lazy loading:
   * - If stats already computed during idle time, returns directly
   * - If not yet computed, computes synchronously and returns
   * - If no file tree, returns empty stats
   */
  get fileTreeStats(): FileTreeStats {
    if (!this._fileTreeStats) {
      return computeFileTreeStats(null);
    }
    return this._fileTreeStats.value;
  }

  get isStatsReady(): boolean {
    return this._fileTreeStats?.isResolved ?? false;
  }

  // ====== Project Operations ======

  setProject(path: string, tree: FileNode, options?: { rebuildIndex?: boolean }): void {
    const rebuildIndex = options?.rebuildIndex ?? true;
    this._projectPath = path;
    this._fileTree = tree;

    this._fileTreeStats?.dispose();
    this._fileTreeStats = new IdleValue(() => computeFileTreeStats(tree));

    this._onDidChangeProject.fire({ path, fileTree: tree });

    if (rebuildIndex) {
      this._buildFilePathIndexAsync(path);
    }
  }

  /**
   * Build file path index in background
   *
   * This is a flat path list independent of fileTree, specifically for @ completion.
   * Unlike fileTree's lazy loading strategy, this scans the entire project directory.
   *
   * Design decisions:
   * - Executes silently in background, doesn't block UI
   * - Results cached in memory, used directly during @ completion
   * - Automatically rebuilds on project switch
   * - Supports cancelling old index and starting new index on project switch
   */
  private async _buildFilePathIndexAsync(projectPath: string): Promise<void> {
    if (this._isIndexing && this._indexingProjectPath === projectPath) {
      logger.debug('Indexing already in progress, skipping (same project)');
      return;
    }

    if (this._isIndexing && this._indexingProjectPath !== projectPath) {
      logger.debug('Project switch detected, old index results will be ignored');
    }

    this._isIndexing = true;
    this._indexingProjectPath = projectPath;
    this._onDidChangeIndexingState.fire(true);

    const startTime = performance.now();
    logger.debug('Starting background file path index build...');

    try {
      const result = await api.file.scanFilePaths(projectPath);

      if (this._projectPath !== projectPath) {
        logger.debug('Index complete but project switched, discarding results');
        return;
      }

      if (result.success && result.paths) {
        const relativePaths = result.paths.map((p) => {
          if (p.startsWith(projectPath)) {
            const relative = p.slice(projectPath.length);
            return relative.replace(/^[/\\]/, '');
          }
          return p;
        });

        this._filePathIndex = relativePaths;
        this._onDidChangeFilePathIndex.fire(relativePaths);

        const elapsed = (performance.now() - startTime).toFixed(0);
        logger.info(
          `File path index build complete: ${relativePaths.length} paths, took ${elapsed}ms`
        );
      } else {
        logger.warn('File path index build failed:', result.error);
      }
    } catch (error) {
      logger.error('File path index build exception:', error);
    } finally {
      if (this._indexingProjectPath === projectPath) {
        this._isIndexing = false;
        this._indexingProjectPath = null;
        this._onDidChangeIndexingState.fire(false);
      }
    }
  }

  async refreshFilePathIndex(): Promise<void> {
    if (!this._projectPath) return;
    await this._buildFilePathIndexAsync(this._projectPath);
  }

  clearProject(): void {
    this._projectPath = null;
    this._fileTree = null;

    this._fileTreeStats?.dispose();
    this._fileTreeStats = null;

    this._filePathIndex = [];
    this._onDidChangeFilePathIndex.fire([]);

    this._onDidChangeProject.fire({ path: null, fileTree: null });
  }

  updateFileTree(tree: FileNode): void {
    this._fileTree = tree;

    this._fileTreeStats?.dispose();
    this._fileTreeStats = new IdleValue(() => computeFileTreeStats(tree));

    this._onDidChangeFileTree.fire(tree);
  }

  /**
   * Update specified directory node's children (lazy loading)
   *
   * Uses Copy-On-Write strategy, only clones nodes on the modified path.
   */
  updateNodeChildren(dirPath: string, children: FileNode[]): void {
    if (!this._fileTree) return;

    const updateNode = (node: FileNode): FileNode => {
      if (node.path === dirPath) {
        return {
          ...node,
          children,
          isResolved: true,
        };
      }

      if (node.children) {
        const newChildren = node.children.map(updateNode);
        const hasChange = newChildren.some((c, i) => c !== node.children![i]);
        if (hasChange) {
          return { ...node, children: newChildren };
        }
      }

      return node;
    };

    const newTree = updateNode(this._fileTree);
    if (newTree !== this._fileTree) {
      logger.debug('[ProjectService] Lazy loading update directory', { dirPath });
      this.updateFileTree(newTree);
    }
  }

  // ====== Incremental Update Logic ======

  /**
   * Apply incremental changes to file tree
   *
   * Much faster than rescanning entire directory tree, avoids UI flicker.
   * Directly patches file tree structure in memory.
   *
   * Design decisions:
   * - Uses Copy-On-Write strategy, clones nodes along modified path
   * - Unmodified subtrees keep original references, benefits React shouldComponentUpdate
   * - Simultaneously incrementally updates file path index, avoids full rebuild
   */
  applyFileChange(delta: FileChangeDelta): void {
    if (!this._fileTree || !this._projectPath) return;

    if (!delta.path.startsWith(this._projectPath)) return;

    const separator = this._projectPath.includes('\\') ? '\\' : '/';

    let newTree: FileNode | null = null;

    if (delta.type === 'add') {
      newTree = this._insertNodeCOW(this._fileTree, delta.path, separator);
    } else if (delta.type === 'unlink') {
      newTree = this._removeNodeCOW(this._fileTree, delta.path, separator);
    }

    if (newTree && newTree !== this._fileTree) {
      logger.debug('[ProjectService] Incremental file tree update', {
        type: delta.type,
        path: delta.path,
      });
      this.updateFileTree(newTree);

      this._updateFilePathIndexIncremental(delta);
    }
  }

  private _updateFilePathIndexIncremental(delta: FileChangeDelta): void {
    if (!this._projectPath) return;

    let relativePath = delta.path;
    if (relativePath.startsWith(this._projectPath)) {
      relativePath = relativePath.slice(this._projectPath.length);
      relativePath = relativePath.replace(/^[/\\]/, '');
    }

    if (delta.type === 'add') {
      if (!this._filePathIndex.includes(relativePath)) {
        this._filePathIndex = [...this._filePathIndex, relativePath];
        this._onDidChangeFilePathIndex.fire(this._filePathIndex);
        logger.debug('[ProjectService] Index incremental add', { relativePath });
      }
    } else if (delta.type === 'unlink') {
      const index = this._filePathIndex.indexOf(relativePath);
      if (index !== -1) {
        this._filePathIndex = [
          ...this._filePathIndex.slice(0, index),
          ...this._filePathIndex.slice(index + 1),
        ];
        this._onDidChangeFilePathIndex.fire(this._filePathIndex);
        logger.debug('[ProjectService] Index incremental remove', { relativePath });
      }
    }
  }

  private _insertNodeCOW(root: FileNode, filePath: string, sep: string): FileNode | null {
    const relativePath = filePath.slice(this._projectPath!.length + 1);
    const parts = relativePath.split(/[/\\]/).filter(Boolean);
    const fileName = parts.pop();

    if (!fileName) return null;

    const cloneAndInsert = (node: FileNode, depth: number): FileNode | null => {
      if (depth === parts.length) {
        if (node.children?.some((c) => c.name === fileName)) return null;

        const newChildren = [
          ...(node.children || []),
          {
            name: fileName,
            path: filePath,
            type: 'file' as const,
          },
        ];
        this._sortChildren(newChildren);

        return { ...node, children: newChildren };
      }

      const targetName = parts[depth];
      if (!node.children) return null;

      const childIndex = node.children.findIndex((c) => c.name === targetName);
      if (childIndex === -1) {
        const newDir: FileNode = {
          name: targetName,
          path: `${node.path}${sep}${targetName}`,
          type: 'directory',
          children: [],
        };

        const insertedDir = cloneAndInsert(newDir, depth + 1);
        if (!insertedDir) return null;

        const newChildren = [...node.children, insertedDir];
        this._sortChildren(newChildren);
        return { ...node, children: newChildren };
      }

      const child = node.children[childIndex];
      if (child.type !== 'directory') return null;

      const newChild = cloneAndInsert(child, depth + 1);
      if (!newChild) return null;

      const newChildren = [...node.children];
      newChildren[childIndex] = newChild;

      return { ...node, children: newChildren };
    };

    return cloneAndInsert(root, 0);
  }

  private _removeNodeCOW(root: FileNode, filePath: string, _sep: string): FileNode | null {
    const relativePath = filePath.slice(this._projectPath!.length + 1);
    const parts = relativePath.split(/[/\\]/).filter(Boolean);
    const fileName = parts.pop();

    if (!fileName) return null;

    const cloneAndRemove = (node: FileNode, depth: number): FileNode | null => {
      if (depth === parts.length) {
        if (!node.children) return null;

        const index = node.children.findIndex((c) => c.name === fileName);
        if (index === -1) return null;

        const newChildren = node.children.filter((_, i) => i !== index);
        return { ...node, children: newChildren };
      }

      const targetName = parts[depth];
      if (!node.children) return null;

      const childIndex = node.children.findIndex((c) => c.name === targetName);
      if (childIndex === -1) return null;

      const child = node.children[childIndex];
      if (child.type !== 'directory') return null;

      const newChild = cloneAndRemove(child, depth + 1);
      if (!newChild) return null;

      const newChildren = [...node.children];
      newChildren[childIndex] = newChild;

      return { ...node, children: newChildren };
    };

    return cloneAndRemove(root, 0);
  }

  private _sortChildren(children: FileNode[]) {
    children.sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'directory') return 1;
      return a.name.localeCompare(b.name);
    });
  }

  // ====== Knowledge Base Operations ======

  setKnowledgeBases(bases: KnowledgeBase[]): void {
    this._knowledgeBases = bases;
    this._onDidChangeKnowledgeBases.fire(bases);
  }

  setSelectedKnowledgeBase(id: string | null): void {
    if (this._selectedKnowledgeBaseId === id) return;
    this._selectedKnowledgeBaseId = id;
    this._onDidChangeSelectedKB.fire(id);
  }

  setCompletionKnowledgeBase(id: string | null): void {
    if (this._completionKnowledgeBaseId === id) return;
    this._completionKnowledgeBaseId = id;
    this._onDidChangeCompletionKB.fire(id);
  }

  // ====== File Conflicts ======

  setFileConflict(conflict: FileConflict | null): void {
    this._fileConflict = conflict;
    this._onDidChangeFileConflict.fire(conflict);
  }

  clearFileConflict(): void {
    this._fileConflict = null;
    this._onDidChangeFileConflict.fire(null);
  }

  // ====== Lifecycle ======

  dispose(): void {
    this._knowledgeBases = [];
    this._fileTreeStats?.dispose();
    this._fileTreeStats = null;
    this._disposables.dispose();
  }
}

let projectService: ProjectService | null = null;

export function getProjectService(): ProjectService {
  if (!projectService) {
    projectService = ProjectService.getInstance();
  }
  return projectService;
}

export function useProjectService(): ProjectService {
  return getProjectService();
}
