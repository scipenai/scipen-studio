import { EventEmitter } from 'node:events';
import { SessionManager } from './session-manager.js';
import { DocumentStateManager } from './document-state-manager.js';
import { SessionRateLimiter } from './rate-limiter.js';
import { GatewayError } from './errors.js';
import {
  addComment,
  createCommentThread,
  createDoc,
  createFolder,
  deleteEntity,
  deleteThread,
  getThreads,
  moveEntity,
  mutateThread,
  normalizeThreads,
  renameEntity,
  uploadFile,
} from './overleaf-api.js';

function buildSessionNotFoundError() {
  return new GatewayError('Session not found', { statusCode: 404 });
}

// ====== Project Tree Incremental Patch ======

/** Find a folder by _id within the rootFolder tree. */
function findFolderById(folder, folderId) {
  if (!folder || !folderId) return null;
  if (folder._id === folderId) return folder;
  for (const sub of (folder.folders || [])) {
    const found = findFolderById(sub, folderId);
    if (found) return found;
  }
  return null;
}

/** Find an entity by _id in the rootFolder tree; returns { entity, parent, collection }. */
function findEntityById(folder, entityId) {
  if (!folder || !entityId) return null;
  for (const doc of (folder.docs || [])) {
    if (doc._id === entityId) return { entity: doc, parent: folder, collection: 'docs' };
  }
  for (const file of (folder.fileRefs || [])) {
    if (file._id === entityId) return { entity: file, parent: folder, collection: 'fileRefs' };
  }
  for (const sub of (folder.folders || [])) {
    if (sub._id === entityId) return { entity: sub, parent: folder, collection: 'folders' };
    const found = findEntityById(sub, entityId);
    if (found) return found;
  }
  return null;
}

/** Remove an entity from its parent's collection; returns the removed object. */
function removeFromCollection(parent, entityId, collection) {
  const arr = parent[collection];
  if (!arr) return null;
  const idx = arr.findIndex(e => e._id === entityId);
  if (idx === -1) return null;
  return arr.splice(idx, 1)[0];
}

/** Apply an incremental patch (from local CRUD or a remote event) to session.project.rootFolder. */
function patchProjectTree(session, event) {
  const root = session?.project?.rootFolder?.[0];
  if (!root || !event?.type) return;
  const t = event.type;

  if ((t === 'entity.created' || t === 'doc.created' || t === 'file.created' || t === 'folder.created') && event.parentFolderId) {
    const parent = findFolderById(root, event.parentFolderId) || root;
    // Entity info may arrive from different event shapes.
    const entity = event.result || event.doc || event.file || event.folder || {};
    const id = entity._id || entity.docId || entity.folderId || '';
    const name = entity.name || '';
    if (!id) return;
    const entityType = event.entityType || (event.doc ? 'doc' : event.file ? 'file' : event.folder ? 'folder' : '');
    if (entityType === 'doc') {
      (parent.docs = parent.docs || []).push({ _id: id, name });
    } else if (entityType === 'file') {
      (parent.fileRefs = parent.fileRefs || []).push({ _id: id, name });
    } else if (entityType === 'folder') {
      (parent.folders = parent.folders || []).push({ _id: id, name, docs: [], fileRefs: [], folders: [] });
    }
  } else if ((t === 'entity.renamed' || t === 'entity.rename') && event.entityId) {
    const found = findEntityById(root, event.entityId);
    if (found && event.newName) found.entity.name = String(event.newName);
  } else if ((t === 'entity.moved' || t === 'entity.move') && event.entityId) {
    const found = findEntityById(root, event.entityId);
    if (found) {
      const removed = removeFromCollection(found.parent, event.entityId, found.collection);
      if (removed) {
        const target = findFolderById(root, event.newFolderId || event.targetFolderId) || root;
        (target[found.collection] = target[found.collection] || []).push(removed);
      }
    }
  } else if ((t === 'entity.removed' || t === 'entity.deleted') && event.entityId) {
    const found = findEntityById(root, event.entityId);
    if (found) removeFromCollection(found.parent, event.entityId, found.collection);
  }
}

export class OverleafLiveBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.documentStates = options.documentStates ?? new DocumentStateManager();
    this.patchRateLimiter = options.patchRateLimiter ?? new SessionRateLimiter(60, 1);
    this.sessions =
      options.sessionManager ??
      new SessionManager({
        onRemoteUpdate: (session, update) => this.handleRemoteUpdate(session, update),
        onTreeEvent: (session, event) => {
          patchProjectTree(session, event);
          this.emit('tree.changed', {
            type: 'tree.changed',
            sessionId: session.sessionId,
            projectId: session.projectId,
            event,
          });
        },
        onThreadEvent: (session, event) => {
          void this.refreshJoinedDocRanges(session, event).catch((error) => {
            this.emit('doc.error', {
              type: 'doc.error',
              sessionId: session.sessionId,
              projectId: session.projectId,
              message: error instanceof Error ? error.message : 'Failed to refresh thread ranges',
            });
          });
        },
        onDisconnect: (session, event) => {
          this.documentStates.markDisconnected(session.sessionId);
          this.documentStates.releaseSession(session.sessionId);
          this.sessions.removeSession(session.sessionId);
          this.emit('session.disconnected', {
            type: 'session.disconnected',
            sessionId: session.sessionId,
            projectId: session.projectId,
            reason: event?.reason || 'upstream disconnected',
          });
        },
      });
  }

  async connectSession(payload) {
    const session = await this.sessions.connectSession(payload);
    return {
      sessionId: session.sessionId,
      sessionType: session.sessionType,
      projectId: session.projectId,
      protocolVersion: session.protocolVersion,
      clientInstanceId: session.clientInstanceId,
    };
  }

  disconnectSession(sessionId) {
    const session = this.sessions.getSession(sessionId);
    if (!session) {
      throw buildSessionNotFoundError();
    }
    this.sessions.disconnectSession(sessionId);
    this.documentStates.releaseSession(sessionId);
    return { success: true, sessionId };
  }

  getSessionOrThrow(sessionId, projectId) {
    const session = this.sessions.getSession(sessionId);
    if (!session || session.projectId !== projectId) {
      throw buildSessionNotFoundError();
    }
    return session;
  }

  async joinDoc({ sessionId, projectId, docId, fromVersion = -1 }) {
    const session = this.getSessionOrThrow(sessionId, projectId);
    const joined = await session.adapter.joinDoc(docId, Number(fromVersion ?? -1));
    const state = this.documentStates.setJoinedState(session.sessionId, docId, {
      version: joined.version,
      content: joined.content,
      ranges: joined.ranges,
      joinEpoch: Date.now(),
    });
    return {
      projectId,
      docId,
      version: state.version,
      content: state.serverContent,
      ranges: state.ranges,
    };
  }

  getProjectSnapshot({ sessionId, projectId }) {
    const session = this.getSessionOrThrow(sessionId, projectId);
    return {
      projectId: session.projectId,
      project: session.project ?? null,
    };
  }

  getDocState({ sessionId, projectId, docId }) {
    this.getSessionOrThrow(sessionId, projectId);
    const state = this.documentStates.getState(sessionId, docId);
    if (!state) {
      throw new GatewayError('Document state not found', { statusCode: 404 });
    }
    return {
      projectId,
      docId,
      version: state.version,
      content: state.serverContent,
      ranges: state.ranges,
    };
  }

  async submitPatches({ sessionId, projectId, docId, baseVersion, patches, requestId }) {
    if (!this.patchRateLimiter.consume(sessionId)) {
      throw new GatewayError('Too many requests', {
        statusCode: 429,
        code: 'RATE_LIMITED',
      });
    }

    const session = this.getSessionOrThrow(sessionId, projectId);
    const requestKey = String(requestId || '');
    const remembered = this.documentStates.getRememberedRequest(sessionId, requestKey);
    if (remembered) {
      return remembered;
    }

    try {
      const prepared = this.documentStates.prepareLocalUpdate(
        sessionId,
        docId,
        Number(baseVersion ?? 0),
        Array.isArray(patches) ? patches : []
      );

      if (!prepared.ops || prepared.ops.length === 0) {
        const noopResult = {
          projectId,
          docId,
          version: prepared.version,
          content: prepared.content,
          patches: [],
          ranges: prepared.ranges,
        };
        this.documentStates.rememberRequest(sessionId, requestKey, noopResult);
        return noopResult;
      }

      await session.adapter.applyOtUpdate(
        docId,
        prepared.ops,
        prepared.state.version,
        prepared.state.serverContent
      );
      const result = this.documentStates.acknowledgeLocalUpdate(sessionId, docId, prepared);
      const payload = {
        type: 'doc.ack',
        sessionId,
        projectId,
        docId,
        version: result.version,
        content: result.content,
        patches: result.patches,
        ranges: result.ranges,
        requestId: requestKey,
      };
      this.documentStates.rememberRequest(sessionId, requestKey, payload);
      this.emit('doc.ack', payload);
      return payload;
    } catch (error) {
      this.documentStates.failLocalUpdate(sessionId, docId);
      if (error?.code === 'STALE_VERSION') {
        throw new GatewayError(error.message, { statusCode: 409, code: error.code });
      }
      throw error;
    }
  }

  async listThreads({ sessionId, projectId }) {
    const session = this.getSessionOrThrow(sessionId, projectId);
    const threads = await getThreads(session, projectId);
    return normalizeThreads(threads);
  }

  async addComment({ sessionId, projectId, threadId, content, docId }) {
    const session = this.getSessionOrThrow(sessionId, projectId);
    await addComment(session, projectId, String(threadId || ''), String(content || ''));
    let ranges;
    if (docId) {
      const joined = await session.adapter.joinDoc(docId, -1);
      this.documentStates.setJoinedState(session.sessionId, docId, {
        version: joined.version,
        content: joined.content,
        ranges: joined.ranges,
        joinEpoch: Date.now(),
      });
      ranges = joined.ranges;
    }
    this.emit('ranges.changed', {
      type: 'ranges.changed',
      sessionId: session.sessionId,
      projectId,
      docId: docId || undefined,
      ranges,
      event: { type: 'thread.comment_added', threadId: String(threadId || '') },
    });
    return { success: true };
  }

  async createThread({ sessionId, projectId, docId, content, ranges }) {
    const session = this.getSessionOrThrow(sessionId, projectId);
    const result = await createCommentThread(
      session,
      projectId,
      String(docId || ''),
      String(content || ''),
      Array.isArray(ranges) ? ranges : [],
      this.documentStates,
    );
    this.emit('ranges.changed', {
      type: 'ranges.changed',
      sessionId: session.sessionId,
      projectId,
      docId: result.docId,
      ranges: result.ranges,
      event: { type: 'thread.created', threadId: result.threadId, docId: result.docId },
    });
    return { success: true, threadId: result.threadId };
  }

  async resolveThread({ sessionId, projectId, threadId, docId }) {
    return await this.runThreadMutation({ sessionId, projectId, threadId, docId, action: 'resolve' });
  }

  async reopenThread({ sessionId, projectId, threadId, docId }) {
    return await this.runThreadMutation({ sessionId, projectId, threadId, docId, action: 'reopen' });
  }

  async deleteThread({ sessionId, projectId, threadId, docId }) {
    return await this.runThreadMutation({ sessionId, projectId, threadId, docId, action: 'delete' });
  }

  async runThreadMutation({ sessionId, projectId, threadId, docId, action }) {
    const session = this.getSessionOrThrow(sessionId, projectId);
    if (action === 'delete') {
      await deleteThread(session, projectId, threadId, docId || undefined);
    } else {
      await mutateThread(session, projectId, threadId, action, docId || undefined);
    }
    let ranges;
    if (docId) {
      const joined = await session.adapter.joinDoc(docId, -1);
      this.documentStates.setJoinedState(session.sessionId, docId, {
        version: joined.version,
        content: joined.content,
        ranges: joined.ranges,
        joinEpoch: Date.now(),
      });
      ranges = joined.ranges;
    }
    this.emit('ranges.changed', {
      type: 'ranges.changed',
      sessionId: session.sessionId,
      projectId,
      docId: docId || undefined,
      ranges,
      event: { type: `thread.${action}`, threadId },
    });
    return { success: true };
  }

  async createEntity({ sessionId, projectId, entityType, parentFolderId, name }) {
    const session = this.getSessionOrThrow(sessionId, projectId);
    let result = {};
    if (entityType === 'doc') {
      result = await createDoc(session, projectId, String(parentFolderId || ''), String(name || ''));
    } else if (entityType === 'folder') {
      result = await createFolder(session, projectId, String(parentFolderId || ''), String(name || ''));
    } else {
      throw new GatewayError('Unsupported entityType for create', { statusCode: 400 });
    }
    const treeEvent = { type: 'entity.created', entityType, parentFolderId: String(parentFolderId || ''), result };
    patchProjectTree(session, treeEvent);
    this.emit('tree.changed', {
      type: 'tree.changed',
      sessionId: session.sessionId,
      projectId,
      event: treeEvent,
    });
    return {
      success: true,
      entityId: result._id || result.docId || result.folderId,
      entityType,
    };
  }

  async patchEntity({ sessionId, projectId, entityId, entityType, action, newName, targetFolderId }) {
    const session = this.getSessionOrThrow(sessionId, projectId);
    if (action === 'rename') {
      await renameEntity(session, projectId, entityType, entityId, String(newName || ''));
    } else if (action === 'move') {
      await moveEntity(session, projectId, entityType, entityId, String(targetFolderId || ''));
    } else {
      throw new GatewayError('Unsupported patch action', { statusCode: 400 });
    }
    const treeEvent = { type: `entity.${action}`, entityType, entityId, newName, targetFolderId };
    patchProjectTree(session, treeEvent);
    this.emit('tree.changed', {
      type: 'tree.changed',
      sessionId: session.sessionId,
      projectId,
      event: treeEvent,
    });
    return { success: true, entityId, entityType };
  }

  async deleteEntity({ sessionId, projectId, entityId, entityType }) {
    const session = this.getSessionOrThrow(sessionId, projectId);
    await deleteEntity(session, projectId, entityType, entityId);
    const treeEvent = { type: 'entity.deleted', entityType, entityId };
    patchProjectTree(session, treeEvent);
    this.emit('tree.changed', {
      type: 'tree.changed',
      sessionId: session.sessionId,
      projectId,
      event: treeEvent,
    });
    return { success: true, entityId, entityType };
  }

  async uploadFile({ sessionId, projectId, parentFolderId, fileName, mimeType, fileDataBase64 }) {
    const session = this.getSessionOrThrow(sessionId, projectId);
    const binary = Buffer.from(String(fileDataBase64 || ''), 'base64');
    const result = await uploadFile(
      session,
      projectId,
      String(parentFolderId || ''),
      String(fileName || ''),
      String(mimeType || 'application/octet-stream'),
      binary,
    );
    const treeEvent = { type: 'entity.created', entityType: 'file', parentFolderId: String(parentFolderId || ''), result: { ...result, name: String(fileName || '') } };
    patchProjectTree(session, treeEvent);
    this.emit('tree.changed', {
      type: 'tree.changed',
      sessionId: session.sessionId,
      projectId,
      event: treeEvent,
    });
    return {
      success: true,
      entityId: result?._id,
      entityType: 'file',
    };
  }

  async refreshJoinedDocRanges(session, event) {
    const docIds = this.documentStates.listDocIds(session.sessionId);
    await Promise.all(
      docIds.map(async (docId) => {
        const joined = await session.adapter.joinDoc(docId, -1);
        this.documentStates.setJoinedState(session.sessionId, docId, {
          version: joined.version,
          content: joined.content,
          ranges: joined.ranges,
          joinEpoch: Date.now(),
        });
        this.emit('ranges.changed', {
          type: 'ranges.changed',
          sessionId: session.sessionId,
          projectId: session.projectId,
          docId,
          ranges: joined.ranges,
          event,
        });
      })
    );
  }

  handleRemoteUpdate(session, update) {
    const state = this.documentStates.applyRemoteUpdate(session.sessionId, update.doc, update);
    if (!state) {
      return;
    }
    this.emit('doc.remote_patch', {
      type: 'doc.remote_patch',
      sessionId: session.sessionId,
      sessionType: session.sessionType || 'user',
      projectId: session.projectId,
      docId: state.docId,
      version: state.version,
      content: state.content,
      patches: state.patches,
      ranges: state.ranges,
      source: state.source,
    });
  }

  dispose() {
    const activeSessions = Array.from(this.sessions.sessions?.keys?.() ?? []);
    for (const sessionId of activeSessions) {
      try {
        this.disconnectSession(sessionId);
      } catch {
      }
    }
    this.documentStates.states?.clear?.();
    this.documentStates.requestCache?.clear?.();
    this.patchRateLimiter.dispose?.();
    this.removeAllListeners();
  }
}
