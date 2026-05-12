/**
 * @file IProjectBindingService - Project binding service contract
 * @description Manages the mapping between local directories and cloud collaborative projects.
 * @depends IDisposable, ProjectBinding types
 */

import type { IDisposable } from '../ServiceContainer';
import type {
  EnsureBindingFromBootstrapParams,
  EnsureBindingFromBootstrapResult,
  ImportProjectParams,
  ImportProjectResult,
  ProjectBindingDTO,
  ProjectBindingStatusEvent,
  ResolveBindingResult,
} from '../../../../shared/api-types';

export interface IProjectBindingService extends IDisposable {
  /**
   * Imports a local directory as a cloud collaborative project.
   * Scans the directory, classifies files, creates the cloud project, uploads, and writes the
   * local marker.
   */
  importProject(params: ImportProjectParams): Promise<ImportProjectResult>;

  /**
   * Unbinds a project, reverting it to a pure local project.
   * Deletes the local DB row and .scipen/project.json but preserves every file.
   */
  unbindProject(projectId: string): Promise<void>;

  /**
   * Looks up a binding by local path.
   */
  getBindingByPath(localRootPath: string): Promise<ProjectBindingDTO | null>;

  /**
   * Looks up a binding by remote project ID.
   */
  getBindingByProjectId(projectId: string): Promise<ProjectBindingDTO | null>;

  /**
   * Resolves the binding state for a local directory.
   * Lookup order: local DB, then .scipen/project.json, then cloud verification.
   */
  resolveBinding(localRootPath: string): Promise<ResolveBindingResult>;

  /**
   * After a successful bootstrap sync, ensures the persistent binding exists and activates
   * collaboration.
   */
  ensureBindingFromBootstrap(
    params: EnsureBindingFromBootstrapParams
  ): Promise<EnsureBindingFromBootstrapResult>;

  /**
   * Toggles the enabled state of a binding.
   */
  setEnabled(projectId: string, enabled: boolean): Promise<void>;

  /**
   * Subscribes to binding status changes.
   */
  onStatusChanged(listener: (event: ProjectBindingStatusEvent) => void): IDisposable;
}

// ====== File classification constants ======

/** OT-managed text file extensions (collaborative-editable) */
export const OT_MANAGED_EXTENSIONS = new Set([
  '.tex',
  '.typ',
  '.md',
  '.bib',
  '.sty',
  '.cls',
  '.json',
  '.yaml',
  '.yml',
  '.txt',
  '.bst',
  '.dtx',
  '.ins',
  '.cfg',
]);

/** Resource file extensions (storage sync only, not routed through OT) */
export const RESOURCE_EXTENSIONS = new Set([
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.svg',
  '.gif',
  '.bmp',
  '.tiff',
  '.csv',
  '.xlsx',
  '.xls',
  '.zip',
  '.tar',
  '.gz',
  '.eps',
  '.ps',
  '.dvi',
]);

/** Directories that are always ignored */
export const ALWAYS_IGNORE_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.DS_Store',
  'dist',
  'build',
  'output',
  '.scipen',
  '.overleaf',
  '__pycache__',
  '.venv',
  '.cache',
  '.tmp',
]);
