/**
 * @file OverleafProjectMetaStore — Overleaf local-first metadata store.
 * @description Manages project metadata (.overleaf/project.json) under
 *   ~/.scipen-studio/overleaf-projects/. Pure local filesystem operations, independent of
 *   Overleaf login state and network connectivity. Kept separate from OverleafProjectDownloader
 *   so metadata can be read during session restore before Overleaf login completes.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';

// ====== Types ======

/** .overleaf/project.json metadata. */
export interface OverleafProjectMeta {
  overleafProjectId: string;
  serverUrl: string;
  projectName: string;
  /** Local relative path -> Overleaf docId. */
  docIdMap: Record<string, string>;
  downloadedAt: string;
}

// ====== Constants ======

const OVERLEAF_PROJECTS_DIR = path.join(os.homedir(), '.scipen-studio', 'overleaf-projects');
const META_DIR = '.overleaf';
const META_FILE = 'project.json';

// ====== API ======

/** Read metadata for a downloaded project. */
export async function getProjectMeta(localPath: string): Promise<OverleafProjectMeta | null> {
  const metaFile = path.join(localPath, META_DIR, META_FILE);
  if (await fs.pathExists(metaFile)) {
    return await fs.readJson(metaFile);
  }
  return null;
}

/** Locate the downloaded local path for a given Overleaf projectId. */
export async function findLocalPath(projectId: string): Promise<string | null> {
  if (!(await fs.pathExists(OVERLEAF_PROJECTS_DIR))) return null;

  const entries = await fs.readdir(OVERLEAF_PROJECTS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaFile = path.join(OVERLEAF_PROJECTS_DIR, entry.name, META_DIR, META_FILE);
    if (await fs.pathExists(metaFile)) {
      const meta = (await fs.readJson(metaFile)) as OverleafProjectMeta;
      if (meta.overleafProjectId === projectId) {
        return path.join(OVERLEAF_PROJECTS_DIR, entry.name);
      }
    }
  }
  return null;
}

/** Update docIdMap in the metadata file. */
export async function updateDocIdMap(
  localPath: string,
  docIdMap: Record<string, string>
): Promise<void> {
  const metaFile = path.join(localPath, META_DIR, META_FILE);
  if (await fs.pathExists(metaFile)) {
    const meta = (await fs.readJson(metaFile)) as OverleafProjectMeta;
    meta.docIdMap = docIdMap;
    await fs.writeJson(metaFile, meta, { spaces: 2 });
  }
}

/** Write the full metadata file. */
export async function writeMeta(localPath: string, meta: OverleafProjectMeta): Promise<void> {
  const metaDir = path.join(localPath, META_DIR);
  await fs.ensureDir(metaDir);
  await fs.writeJson(path.join(metaDir, META_FILE), meta, { spaces: 2 });
}

/** Overleaf project root directory exports. */
export { OVERLEAF_PROJECTS_DIR, META_DIR };
