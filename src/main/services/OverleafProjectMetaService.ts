/**
 * @file OverleafProjectMetaService — project metadata (list/settings/download), project tree
 *   cache, and path->docId resolution.
 * @description Project tree is fetched via StudioOverleafLiveService's bridge snapshot (the
 *   only path). Document content comes from liveService.getDocContent. Auth is provided by
 *   OverleafAuthService.
 */

import type { OverleafAuthService } from './OverleafAuthService';
import type { StudioOverleafLiveService } from './StudioOverleafLiveService';
import { createLogger } from './LoggerService';

const logger = createLogger('OverleafProjectMetaService');

// ====== API response types (internal) ======

interface OverleafProjectsResponse {
  projects?: OverleafProjectItem[];
}

interface OverleafProjectItem {
  _id?: string;
  id?: string;
  name: string;
  lastUpdated?: string;
}

interface OverleafEntitySummary {
  _id?: string;
  id?: string;
  path?: string;
  type?: string;
  name?: string;
}

// ====== Exported types ======

export interface OverleafProject {
  id: string;
  name: string;
  lastUpdated: string;
  owner?: {
    id: string;
    email: string;
    firstName?: string;
    lastName?: string;
  };
  accessLevel?: 'owner' | 'readAndWrite' | 'readOnly';
  compiler?: string;
  rootDocId?: string;
}

export interface FileEntity {
  _id?: string;
  id?: string;
  name: string;
  type: 'doc' | 'file' | 'folder';
  linkedFileData?: {
    provider: string;
    source_project_id?: string;
    source_entity_path?: string;
  };
}

export interface FolderEntity extends FileEntity {
  type: 'folder';
  docs: FileEntity[];
  fileRefs: FileEntity[];
  folders: FolderEntity[];
}

export function getEntityId(entity: { _id?: string; id?: string } | null | undefined): string {
  return entity?._id || entity?.id || '';
}

export interface ProjectDetails {
  _id: string;
  name: string;
  rootDoc_id: string;
  rootFolder: FolderEntity[];
  compiler: string;
  spellCheckLanguage: string;
  members: Array<{
    _id: string;
    email: string;
    privileges: string;
  }>;
  owner: {
    _id: string;
    email: string;
    first_name?: string;
    last_name?: string;
  };
}

// ====== Internal constants ======

const PROJECT_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// ====== Service ======

export class OverleafProjectMetaService {
  private readonly auth: OverleafAuthService;
  private readonly liveService: StudioOverleafLiveService;
  private projectDetailsCache: Map<string, { details: ProjectDetails; timestamp: number }> =
    new Map();
  private readonly disposables: Array<{ dispose(): void }> = [];

  constructor(auth: OverleafAuthService, liveService: StudioOverleafLiveService) {
    this.auth = auth;
    this.liveService = liveService;
    this.disposables.push(
      this.liveService.onDidReceiveTree((payload) => {
        // The project-tree snapshot is cached for 10 minutes; live tree events must
        // invalidate it immediately, otherwise rename/delete/create succeed but subsequent
        // refreshes keep serving stale data until restart or TTL expiry.
        this.invalidateProjectCache(payload.projectId);
      })
    );
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.projectDetailsCache.clear();
  }

  // ==================== Project list ====================

  /** Call after file operations to force fresh data on next fetch */
  invalidateProjectCache(projectId: string): void {
    this.projectDetailsCache.delete(projectId);
  }

  async getProjects(): Promise<Array<{ id: string; name: string; lastUpdated: string }>> {
    if (!this.auth.isLoggedIn()) {
      throw new Error('Please login first');
    }

    const response = await fetch(`${this.auth.getServerUrl()!}/user/projects`, {
      method: 'GET',
      headers: {
        Cookie: this.auth.getCookies()!,
      },
    });

    const data = (await response.json()) as OverleafProjectsResponse;
    return (data.projects || []).map((p: OverleafProjectItem) => ({
      id: p._id || p.id || '',
      name: p.name,
      lastUpdated: p.lastUpdated || '',
    }));
  }

  // ==================== Project settings ====================

  async updateProjectSettings(
    projectId: string,
    settings: { compiler?: string; rootDocId?: string; spellCheckLanguage?: string }
  ): Promise<boolean> {
    if (!this.auth.isLoggedIn()) {
      return false;
    }

    try {
      const response = await fetch(`${this.auth.getServerUrl()!}/project/${projectId}/settings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Connection: 'keep-alive',
          Cookie: this.auth.getCookies()!,
        },
        body: JSON.stringify({
          _csrf: this.auth.getCsrfToken()!,
          ...settings,
        }),
      });

      return response.ok;
    } catch {
      return false;
    }
  }

  // ==================== Project details ====================

  /** Get project details via the bridge snapshot (the only path), with a local cache. */
  async getProjectDetailsCached(projectId: string): Promise<ProjectDetails | null> {
    // 1. Cache.
    const cached = this.projectDetailsCache.get(projectId);
    if (cached && Date.now() - cached.timestamp < PROJECT_CACHE_TTL) {
      if (this.isProjectTreeComplete(cached.details)) {
        return cached.details;
      }
      this.projectDetailsCache.delete(projectId);
    }

    // 2. Prefer a fresh HTTP fetch. bridge.getProjectSnapshot() returns session.project,
    // which does not auto-refresh on rename/move/delete/create. Treating the snapshot as
    // the source of truth would force manual-refresh to serve stale trees until reconnect.
    const fresh = await this.getProjectDetailsFresh(projectId);
    if (fresh && this.isProjectTreeComplete(fresh)) {
      this.projectDetailsCache.set(projectId, { details: fresh, timestamp: Date.now() });
      return fresh;
    }

    // 3. Fall back to the bridge snapshot only when HTTP fails.
    const snapshot = await this.liveService.getProjectSnapshot(projectId);
    if (!snapshot?.project) {
      console.error('[OverleafProjectMetaService] bridge snapshot returned null for', projectId);
      return fresh;
    }

    const project = snapshot.project as ProjectDetails;
    if (this.isProjectTreeComplete(project)) {
      this.projectDetailsCache.set(projectId, { details: project, timestamp: Date.now() });
    }
    return project;
  }

  // ==================== Project tree validation ====================

  private isProjectTreeComplete(project: ProjectDetails): boolean {
    const root = project?.rootFolder?.[0];
    if (!root) return false;
    return this.isFolderComplete(root);
  }

  private isFolderComplete(folder: FolderEntity): boolean {
    for (const doc of folder.docs || []) {
      if (!getEntityId(doc)) return false;
    }
    for (const fileRef of folder.fileRefs || []) {
      if (!getEntityId(fileRef)) return false;
    }
    for (const sub of folder.folders || []) {
      if (!getEntityId(sub)) return false;
      if (!this.isFolderComplete(sub)) return false;
    }
    return true;
  }

  private findDocIdInFolder(
    folder: FolderEntity,
    targetPath: string,
    currentPath = ''
  ): string | null {
    for (const doc of folder.docs || []) {
      const docPath = currentPath ? `${currentPath}/${doc.name}` : doc.name;
      if (docPath === targetPath || doc.name === targetPath) {
        return getEntityId(doc);
      }
    }

    for (const fileRef of folder.fileRefs || []) {
      const filePath = currentPath ? `${currentPath}/${fileRef.name}` : fileRef.name;
      if (filePath === targetPath || fileRef.name === targetPath) {
        return getEntityId(fileRef);
      }
    }

    for (const subFolder of folder.folders || []) {
      const subPath = currentPath ? `${currentPath}/${subFolder.name}` : subFolder.name;
      const result = this.findDocIdInFolder(subFolder, targetPath, subPath);
      if (result) {
        return result;
      }
    }

    return null;
  }

  private async getProjectDetailsFresh(projectId: string): Promise<ProjectDetails | null> {
    if (!this.auth.isLoggedIn()) {
      throw new Error('Please login first');
    }

    try {
      const response = await fetch(`${this.auth.getServerUrl()!}/project/${projectId}`, {
        method: 'GET',
        headers: {
          Cookie: this.auth.getCookies()!,
          Accept: 'text/html',
        },
      });
      this.auth.absorbResponseCookies(response);

      if (!response.ok) {
        console.error('[OverleafProjectMetaService] Get project page failed:', response.status);
        return null;
      }

      const html = await response.text();
      let projectData: ProjectDetails | null = null;

      const rootFolderMatch = html.match(
        /<meta\s+name="ol-rootFolder"\s+data-type="json"\s+content="([^"]*)"/i
      );
      if (rootFolderMatch) {
        try {
          const decoded = this.decodeHtmlEntities(rootFolderMatch[1]);
          const rootFolder = JSON.parse(decoded);
          const rootDocIdMatch = html.match(/<meta\s+name="ol-rootDoc_id"\s+content="([^"]*)"/i);

          projectData = {
            _id: projectId,
            name: this.extractMetaContent(html, 'ol-projectName') || 'Remote Project',
            rootDoc_id: rootDocIdMatch ? rootDocIdMatch[1] : '',
            rootFolder,
            compiler: this.extractMetaContent(html, 'ol-compiler') || 'pdflatex',
            spellCheckLanguage: this.extractMetaContent(html, 'ol-spellCheckLanguage') || 'en',
            members: [],
            owner: { _id: '', email: '' },
          };
        } catch (error) {
          console.error('[OverleafProjectMetaService] Failed to parse rootFolder meta:', error);
        }
      }

      if (!projectData) {
        const projectMetaPatterns = [
          /<meta\s+name="ol-project"\s+data-type="json"\s+content="([^"]*)"/i,
          /<meta\s+name="ol-project"\s+content="([^"]*)"/i,
        ];

        for (const pattern of projectMetaPatterns) {
          const match = html.match(pattern);
          if (!match) continue;
          try {
            const decoded = this.decodeHtmlEntities(match[1]);
            projectData = JSON.parse(decoded) as ProjectDetails;
            break;
          } catch (error) {
            console.error('[OverleafProjectMetaService] Failed to parse ol-project meta:', error);
          }
        }
      }

      if (!projectData) {
        const windowPatterns = [
          /window\.project\s*=\s*(\{[\s\S]*?\});\s*(?:window\.|var\s|const\s|let\s|<\/script>)/,
          /window\._ide\s*=\s*\{[^}]*project\s*:\s*(\{[\s\S]*?\})/,
        ];

        for (const pattern of windowPatterns) {
          const match = html.match(pattern);
          if (!match) continue;
          try {
            projectData = JSON.parse(match[1]) as ProjectDetails;
            break;
          } catch (error) {
            console.error('[OverleafProjectMetaService] Failed to parse window var:', error);
          }
        }
      }

      if (projectData) {
        return projectData;
      }

      const entitiesResponse = await fetch(
        `${this.auth.getServerUrl()!}/project/${projectId}/entities`,
        {
          method: 'GET',
          headers: {
            Cookie: this.auth.getCookies()!,
            Accept: 'application/json',
          },
        }
      );
      this.auth.absorbResponseCookies(entitiesResponse);

      if (!entitiesResponse.ok) {
        return null;
      }

      const entitiesData = (await entitiesResponse.json()) as {
        entities?: OverleafEntitySummary[];
        project?: {
          name?: string;
          rootDoc_id?: string;
          compiler?: string;
          spellCheckLanguage?: string;
        };
        name?: string;
      };

      if (!entitiesData.entities || !Array.isArray(entitiesData.entities)) {
        return null;
      }

      const rootFolder = this.entitiesToFolderTree(entitiesData.entities);
      return {
        _id: projectId,
        name: entitiesData.project?.name || entitiesData.name || 'Remote Project',
        rootDoc_id: entitiesData.project?.rootDoc_id || '',
        rootFolder: [rootFolder],
        compiler: entitiesData.project?.compiler || 'pdflatex',
        spellCheckLanguage: entitiesData.project?.spellCheckLanguage || 'en',
        members: [],
        owner: { _id: '', email: '' },
      };
    } catch (error) {
      console.error('[OverleafProjectMetaService] Get project details error:', error);
      return null;
    }
  }

  private extractMetaContent(html: string, name: string): string | null {
    const pattern = new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`, 'i');
    const match = html.match(pattern);
    return match ? this.decodeHtmlEntities(match[1]) : null;
  }

  private decodeHtmlEntities(str: string): string {
    return str
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&#x2F;/g, '/')
      .replace(/&apos;/g, "'");
  }

  private entitiesToFolderTree(entities: OverleafEntitySummary[]): FolderEntity {
    const root: FolderEntity = {
      _id: 'root',
      name: '',
      type: 'folder',
      docs: [],
      fileRefs: [],
      folders: [],
    };

    const folderMap = new Map<string, FolderEntity>();
    folderMap.set('', root);

    const sortedEntities = [...entities].sort((a, b) =>
      String(a.path || '').localeCompare(String(b.path || ''))
    );

    for (const entity of sortedEntities) {
      const entityId = entity._id || entity.id || '';
      const entityPath = entity.path || '';
      const entityType = entity.type || '';

      if (!entityPath) continue;

      const pathParts = entityPath.split('/').filter((p) => p);
      if (pathParts.length === 0) continue;

      let currentPath = '';
      for (let i = 0; i < pathParts.length - 1; i++) {
        const parentPath = currentPath;
        currentPath = currentPath ? `${currentPath}/${pathParts[i]}` : pathParts[i];

        if (!folderMap.has(currentPath)) {
          const newFolder: FolderEntity = {
            _id: `folder_${currentPath}`,
            name: pathParts[i],
            type: 'folder',
            docs: [],
            fileRefs: [],
            folders: [],
          };
          folderMap.set(currentPath, newFolder);

          const parent = folderMap.get(parentPath);
          if (parent) {
            parent.folders.push(newFolder);
          }
        }
      }

      const fileName = pathParts[pathParts.length - 1];
      const parentPath = pathParts.slice(0, -1).join('/');
      const parent = folderMap.get(parentPath) || root;

      if (entityType === 'folder') {
        if (!folderMap.has(entityPath)) {
          const folder: FolderEntity = {
            _id: entityId || `folder_${entityPath}`,
            name: fileName,
            type: 'folder',
            docs: [],
            fileRefs: [],
            folders: [],
          };
          folderMap.set(entityPath, folder);
          parent.folders.push(folder);
        }
      } else if (entityType === 'doc') {
        parent.docs.push({
          _id: entityId,
          name: fileName,
          type: 'doc',
        });
      } else if (entityType === 'file') {
        parent.fileRefs.push({
          _id: entityId,
          name: fileName,
          type: 'file',
        });
      }
    }

    return root;
  }

  // ==================== Doc path resolution ====================

  /** Look up docId in project details and fetch its content via liveService. */
  async getDocByPathWithId(
    projectId: string,
    filePath: string
  ): Promise<{ content: string; docId: string } | null> {
    if (!this.auth.isLoggedIn()) {
      throw new Error('Please login first');
    }

    const normalizedPath = filePath.startsWith('/') ? filePath.slice(1) : filePath;

    try {
      // 1. Look up docId from project details (cache or HTTP).
      const projectDetails = await this.getProjectDetailsCached(projectId);
      if (projectDetails?.rootFolder?.[0]) {
        const docId = this.findDocIdInFolder(projectDetails.rootFolder[0], normalizedPath);
        if (docId) {
          const content = await this.liveService.getDocContent(projectId, docId);
          if (content !== null) {
            return { content, docId };
          }
        }
      }

      logger.info('getDocByPathWithId: doc not found by path', {
        projectId,
        normalizedPath,
      });
      return null;
    } catch (error) {
      logger.error('Get doc by path with id error', error);
      return null;
    }
  }

  async getDocByPath(projectId: string, filePath: string): Promise<string | null> {
    const result = await this.getDocByPathWithId(projectId, filePath);
    return result?.content || null;
  }

  // ==================== File download ====================

  async downloadFile(projectId: string, fileId: string): Promise<ArrayBuffer | null> {
    if (!this.auth.isLoggedIn()) {
      throw new Error('Please login first');
    }

    try {
      const response = await fetch(
        `${this.auth.getServerUrl()!}/project/${projectId}/file/${fileId}`,
        {
          method: 'GET',
          headers: {
            Cookie: this.auth.getCookies()!,
          },
        }
      );

      if (!response.ok) {
        return null;
      }

      return await response.arrayBuffer();
    } catch (error) {
      console.error('[OverleafProjectMetaService] Download file error:', error);
      return null;
    }
  }
}
