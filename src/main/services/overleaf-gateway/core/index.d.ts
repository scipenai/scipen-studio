import { EventEmitter } from 'node:events';

export interface OverleafLiveConfigurePayload {
  serverUrl: string;
  projectId: string;
  cookies: string;
  clientInstanceId?: string;
  sessionType?: 'user' | 'bot';
}

export interface OverleafLiveSessionConnection {
  sessionId: string;
  sessionType: 'user' | 'bot';
  projectId: string;
  protocolVersion: number | null;
  clientInstanceId: string | null;
}

export interface OverleafLiveDocState {
  projectId: string;
  docId: string;
  version: number;
  content: string;
  ranges?: Record<string, unknown>;
}

export interface OverleafLiveOffsetPatch {
  offset: number;
  deleteCount: number;
  insertText: string;
}

export interface OverleafLivePatchResult extends OverleafLiveDocState {
  type?: string;
  patches: OverleafLiveOffsetPatch[];
  requestId?: string;
}

export interface OverleafLiveEntityResult {
  success: boolean;
  entityId?: string;
  entityType?: 'doc' | 'file' | 'folder';
  error?: string;
}

export interface OverleafThreadDTO {
  id: string;
  resolved: boolean;
  resolved_by_user?: Record<string, unknown> | null;
  messages: Array<Record<string, unknown>>;
}

export class GatewayError extends Error {
  statusCode: number;
  code: string | null;
}

export class OverleafLiveBridge extends EventEmitter {
  constructor(options?: Record<string, unknown>);
  connectSession(payload: OverleafLiveConfigurePayload): Promise<OverleafLiveSessionConnection>;
  disconnectSession(sessionId: string): { success: true; sessionId: string };
  joinDoc(payload: { sessionId: string; projectId: string; docId: string; fromVersion?: number }): Promise<OverleafLiveDocState>;
  getProjectSnapshot(payload: { sessionId: string; projectId: string }): { projectId: string; project: unknown };
  getDocState(payload: { sessionId: string; projectId: string; docId: string }): OverleafLiveDocState;
  submitPatches(payload: {
    sessionId: string;
    projectId: string;
    docId: string;
    baseVersion: number;
    patches: OverleafLiveOffsetPatch[];
    requestId?: string;
  }): Promise<OverleafLivePatchResult>;
  listThreads(payload: { sessionId: string; projectId: string }): Promise<OverleafThreadDTO[]>;
  createThread(payload: { sessionId: string; projectId: string; docId: string; content: string; ranges: Array<{ pos: number; length: number }> }): Promise<{ success: boolean; threadId?: string }>;
  addComment(payload: { sessionId: string; projectId: string; threadId: string; content: string; docId?: string }): Promise<{ success: boolean }>;
  resolveThread(payload: { sessionId: string; projectId: string; threadId: string; docId?: string }): Promise<{ success: boolean }>;
  reopenThread(payload: { sessionId: string; projectId: string; threadId: string; docId?: string }): Promise<{ success: boolean }>;
  deleteThread(payload: { sessionId: string; projectId: string; threadId: string; docId?: string }): Promise<{ success: boolean }>;
  createEntity(payload: { sessionId: string; projectId: string; entityType: 'doc' | 'folder'; parentFolderId: string; name: string }): Promise<OverleafLiveEntityResult>;
  patchEntity(payload: { sessionId: string; projectId: string; entityId: string; entityType: 'doc' | 'file' | 'folder'; action: 'rename' | 'move'; newName?: string; targetFolderId?: string }): Promise<OverleafLiveEntityResult>;
  deleteEntity(payload: { sessionId: string; projectId: string; entityId: string; entityType: 'doc' | 'file' | 'folder' }): Promise<OverleafLiveEntityResult>;
  uploadFile(payload: { sessionId: string; projectId: string; parentFolderId: string; fileName: string; mimeType: string; fileDataBase64: string }): Promise<OverleafLiveEntityResult>;
  dispose(): void;
}
