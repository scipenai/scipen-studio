import crypto from 'node:crypto';
import { GatewayError } from './errors.js';

async function readText(response) {
  return await response.text();
}

async function requestJson(response) {
  const text = await readText(response);
  if (!text) {
    return {};
  }
  return JSON.parse(text);
}

export async function overleafRequest(session, path, options = {}) {
  const url = `${session.serverUrl.replace(/\/+$/, '')}${path}`;
  const headers = {
    Cookie: session.cookies,
    'X-Csrf-Token': session.csrfToken || '',
    Connection: 'keep-alive',
    ...(options.headers || {}),
  };
  return await fetch(url, {
    ...options,
    headers,
  });
}

function ensureOk(response, message, allowed = [200, 204]) {
  if (allowed.includes(response.status)) {
    return;
  }
  throw new GatewayError(`${message}: ${response.status}`);
}

export async function createDoc(session, projectId, parentFolderId, name) {
  const response = await overleafRequest(session, `/project/${projectId}/doc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      _csrf: session.csrfToken,
      name,
      parent_folder_id: parentFolderId,
    }),
  });
  ensureOk(response, 'Failed to create doc');
  return await requestJson(response);
}

export async function createFolder(session, projectId, parentFolderId, name) {
  const response = await overleafRequest(session, `/project/${projectId}/folder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      _csrf: session.csrfToken,
      name,
      parent_folder_id: parentFolderId,
    }),
  });
  ensureOk(response, 'Failed to create folder');
  return await requestJson(response);
}

export async function renameEntity(session, projectId, entityType, entityId, newName) {
  const response = await overleafRequest(session, `/project/${projectId}/${entityType}/${entityId}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      _csrf: session.csrfToken,
      name: newName,
    }),
  });
  ensureOk(response, 'Failed to rename entity');
}

export async function moveEntity(session, projectId, entityType, entityId, targetFolderId) {
  const response = await overleafRequest(session, `/project/${projectId}/${entityType}/${entityId}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      _csrf: session.csrfToken,
      folder_id: targetFolderId,
    }),
  });
  ensureOk(response, 'Failed to move entity');
}

export async function deleteEntity(session, projectId, entityType, entityId) {
  const response = await overleafRequest(session, `/project/${projectId}/${entityType}/${entityId}`, {
    method: 'DELETE',
  });
  ensureOk(response, 'Failed to delete entity');
}

export async function uploadFile(session, projectId, parentFolderId, fileName, mimeType, binary) {
  const formData = new FormData();
  const blob = new Blob([binary], { type: mimeType || 'application/octet-stream' });
  formData.append('targetFolderId', parentFolderId);
  formData.append('name', fileName);
  formData.append('type', mimeType || 'application/octet-stream');
  formData.append('qqfile', blob, fileName);

  const response = await overleafRequest(
    session,
    `/project/${projectId}/upload?folder_id=${encodeURIComponent(parentFolderId)}`,
    {
      method: 'POST',
      body: formData,
    }
  );
  ensureOk(response, 'Failed to upload file', [200, 201, 204]);
  return await requestJson(response);
}

export async function getThreads(session, projectId) {
  const response = await overleafRequest(session, `/project/${projectId}/threads`, { method: 'GET' });
  ensureOk(response, 'Failed to get threads', [200]);
  return await requestJson(response);
}

export async function addComment(session, projectId, threadId, content) {
  const response = await overleafRequest(session, `/project/${projectId}/thread/${threadId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  ensureOk(response, 'Failed to add comment', [200, 201, 204]);
  return await requestJson(response);
}

export async function mutateThread(session, projectId, threadId, action, docId) {
  const scopedPath = docId
    ? `/project/${projectId}/doc/${docId}/thread/${threadId}/${action}`
    : `/project/${projectId}/thread/${threadId}/${action}`;
  const response = await overleafRequest(session, scopedPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  ensureOk(response, `Failed to ${action} thread`, [200, 201, 204]);
}

export async function deleteThread(session, projectId, threadId, docId) {
  const scopedPath = docId
    ? `/project/${projectId}/doc/${docId}/thread/${threadId}`
    : `/project/${projectId}/thread/${threadId}`;
  const response = await overleafRequest(session, scopedPath, { method: 'DELETE' });
  ensureOk(response, 'Failed to delete thread', [200, 204]);
}

export async function createCommentThread(session, projectId, docId, content, ranges, documentStates) {
  const threadId = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  await addComment(session, projectId, threadId, content);

  const state = documentStates.getState(session.sessionId, docId);
  if (!state) {
    throw new GatewayError('Document state not found; join document before creating thread', { statusCode: 404 });
  }

  const update = {
    doc: docId,
    op: [
      {
        commentId: threadId,
        ranges,
      },
    ],
    v: state.version,
    lastV: state.version,
  };

  await session.adapter.applyCustomUpdate(docId, update);
  const joined = await session.adapter.joinDoc(docId, -1);
  documentStates.setJoinedState(session.sessionId, docId, {
    version: joined.version,
    content: joined.content,
    ranges: joined.ranges,
    joinEpoch: Date.now(),
  });

  return {
    success: true,
    threadId,
    docId,
    ranges: joined.ranges,
  };
}

export function normalizeThreads(rawThreads) {
  if (!rawThreads || typeof rawThreads !== 'object') {
    return [];
  }
  return Object.entries(rawThreads).map(([threadId, thread]) => ({
    id: threadId,
    resolved: thread?.resolved != null && thread?.resolved !== false,
    resolved_by_user: thread?.resolved_by_user ?? null,
    messages: Array.isArray(thread?.messages) ? thread.messages : [],
  }));
}
