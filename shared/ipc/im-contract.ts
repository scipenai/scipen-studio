/**
 * @file IM/Collaboration IPC Contract
 * @description Instant Messaging, Collaboration, ProjectConversation types and channel contract
 * @depends ipc/channels
 */

import { IpcChannel } from './channels';

// ====== IM Connection Types ======

export type StudioIMConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
export type StudioIMContentType = 'text' | 'image' | 'file';

// ====== IM Message Types ======

export interface StudioIMMessageQuoteDTO {
  id: string;
  sender_id: string;
  sender_name: string;
  content: string;
  content_type: StudioIMContentType;
}

export type StudioIMCollaborationProvider = 'im-local' | 'scipen-ot' | 'overleaf';
export type StudioIMCollaborationMode = 'im-local' | 'ot-project';

export interface StudioIMCollaborationCapabilitiesDTO {
  propose_edit: boolean;
  collaborative_tree: boolean;
  collaborative_read: boolean;
  collaborative_edit: boolean;
}

export interface StudioIMCollaborationContextDTO {
  provider?: StudioIMCollaborationProvider;
  mode?: StudioIMCollaborationMode;
  project_id?: string;
  doc_id?: string;
  file_id?: string;
  file_path?: string | null;
  root_path?: string | null;
  project_name?: string | null;
  workspace_id?: string | null;
  scope_type?: 'global' | 'project' | null;
  can_collaborate?: boolean | null;
  capabilities?: StudioIMCollaborationCapabilitiesDTO;
  /** Flat list of project file relative paths; conveys structure to OpenClaw. */
  file_tree?: string[];
  /** Content of the active editor file (truncated) for OpenClaw context. */
  active_file_content?: string;
}

export type CollaborationBackend = 'scipen-ot' | 'overleaf' | 'local';

export interface CollaborationOwnerClaimDTO {
  backend: CollaborationBackend;
  projectId?: string | null;
  rootPath?: string | null;
  fileId?: string | null;
}

export interface CollaborationOwnerDTO {
  backend: CollaborationBackend;
  windowId: number;
  projectId?: string | null;
  rootPath?: string | null;
  fileId?: string | null;
}

/** AI edit proposal produced by the propose_edit tool; Studio parses it for Diff Review. */
export interface EditProposalDTO {
  file_path: string;
  old_string: string;
  new_string: string;
  description?: string;
}

export interface StudioIMMessageMetadataDTO {
  collaboration?: StudioIMCollaborationContextDTO | null;
  /** True while the AI streams a reply, false once complete. */
  streaming?: boolean;
  /** AI edit proposals; only written to files once the user accepts them. */
  proposals?: EditProposalDTO[];
}

export interface StudioIMMessageDTO {
  id: string;
  conversation_id: string;
  sender_id: string;
  sender_name: string;
  content: string;
  content_type: StudioIMContentType;
  quoted_message_id: string | null;
  quoted_message?: StudioIMMessageQuoteDTO | null;
  file_url: string | null;
  file_name: string | null;
  file_size: number | null;
  thumbnail_url: string | null;
  metadata?: StudioIMMessageMetadataDTO | null;
  created_at: string;
}

// ====== IM Operation Params ======

export interface StudioIMConnectParams {
  baseUrl: string;
  token: string;
  conversationId: string;
}

export interface StudioIMListConversationsParams {
  baseUrl: string;
  token: string;
}

export interface StudioIMConversationDTO {
  id: string;
  type: 'direct' | 'group';
  title: string | null;
  unread_count: number;
  created_at: string;
  last_message?: {
    id: string;
    content: string;
    sender_id: string;
    created_at: string;
  } | null;
}

export interface StudioIMConversationMemberDTO {
  user_id: string;
  username: string;
  display_name: string;
  role: string;
}

export interface StudioIMCreateConversationParams {
  baseUrl: string;
  token: string;
  type: 'direct' | 'group';
  memberIds: string[];
  title?: string;
}

export interface StudioIMSendMessageParams {
  conversationId: string;
  content: string;
  contentType?: StudioIMContentType;
  quotedMessageId?: string;
  fileUrl?: string;
  fileName?: string;
  fileSize?: number;
  thumbnailUrl?: string;
  metadata?: StudioIMMessageMetadataDTO;
}

export interface StudioIMUploadAttachmentParams {
  name: string;
  mimeType: string;
  data: Uint8Array;
}

export interface StudioIMUploadAttachmentResult {
  file_url: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  thumbnail_url: string | null;
}

export interface IMSnapshot {
  conversationId: string;
  state: StudioIMConnectionState;
  lastSyncedAt: number | null;
  messages: StudioIMMessageDTO[];
  typingUserIds: string[];
}

// ====== IM Event DTOs ======

export interface IMConnectionStateDTO {
  conversationId: string;
  state: StudioIMConnectionState;
  lastSyncedAt: number | null;
}

export interface IMMessagesChangedDTO {
  conversationId: string;
  messages: StudioIMMessageDTO[];
  lastSyncedAt: number | null;
}

export interface IMTypingDTO {
  conversationId: string;
  userIds: string[];
}

export interface IMErrorDTO {
  scope: 'connect' | 'poll' | 'send' | 'upload' | 'ws' | 'reconnect';
  message: string;
}

// ====== Project Conversation Types ======

export type ProjectConversationScopeType = 'global' | 'project';
export type ProjectConversationRuntime = 'openclaw';

export interface ProjectConversationBindingDTO {
  id: string;
  runtime: ProjectConversationRuntime;
  conversationId: string;
  scopeType: ProjectConversationScopeType;
  scopeKey: string;
  projectId: string | null;
  localRootPath: string | null;
  workspaceId: string | null;
  title: string | null;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number | null;
}

export interface ProjectConversationResolveParams {
  runtime: ProjectConversationRuntime;
  scopeType: ProjectConversationScopeType;
  projectId?: string | null;
  localRootPath?: string | null;
  workspaceId?: string | null;
  title?: string | null;
  createIfMissing?: boolean;
  imConfig: {
    baseUrl: string;
    token: string;
  };
}

export interface ProjectConversationCreateParams {
  runtime: ProjectConversationRuntime;
  scopeType: ProjectConversationScopeType;
  projectId?: string | null;
  localRootPath?: string | null;
  workspaceId?: string | null;
  title?: string | null;
  imConfig: {
    baseUrl: string;
    token: string;
  };
}

export interface ProjectConversationListParams {
  runtime: ProjectConversationRuntime;
  scopeType: ProjectConversationScopeType;
  projectId?: string | null;
  localRootPath?: string | null;
}

export interface ProjectConversationSetDefaultParams {
  bindingId: string;
}

/** Main-to-renderer push event: conversation binding changed. */
export interface ProjectConversationBindingChangedEvent {
  runtime: ProjectConversationRuntime;
  scopeType: 'global' | 'project';
  projectId: string | null;
  localRootPath: string | null;
  workspaceId: string | null;
  bindingId: string | null;
  reason: 'created' | 'set_default' | 'updated' | 'deleted';
}

// ====== Channel Contract ======

export interface IPCImContract {
  // ============ IM ============
  [IpcChannel.IM_Connect]: {
    args: [config: StudioIMConnectParams];
    result: IMSnapshot;
  };
  [IpcChannel.IM_Disconnect]: {
    args: [];
    result: void;
  };
  [IpcChannel.IM_GetSnapshot]: {
    args: [];
    result: IMSnapshot;
  };
  [IpcChannel.IM_ListConversations]: {
    args: [params: StudioIMListConversationsParams];
    result: StudioIMConversationDTO[];
  };
  [IpcChannel.IM_CreateConversation]: {
    args: [params: StudioIMCreateConversationParams];
    result: StudioIMConversationDTO;
  };
  [IpcChannel.IM_GetConversationMembers]: {
    args: [baseUrl: string, token: string, conversationId: string];
    result: StudioIMConversationMemberDTO[];
  };
  [IpcChannel.IM_GetBotUserId]: {
    args: [baseUrl: string, token: string];
    result: string;
  };
  [IpcChannel.IM_SendMessage]: {
    args: [params: StudioIMSendMessageParams];
    result: StudioIMMessageDTO;
  };
  [IpcChannel.IM_UploadAttachment]: {
    args: [params: StudioIMUploadAttachmentParams];
    result: StudioIMUploadAttachmentResult;
  };
  [IpcChannel.IM_SendTyping]: {
    args: [conversationId: string];
    result: void;
  };

  // ============ Collaboration Owner ============
  [IpcChannel.CollaborationOwner_SetActive]: {
    args: [owner: CollaborationOwnerClaimDTO];
    result: CollaborationOwnerDTO;
  };
  [IpcChannel.CollaborationOwner_Clear]: {
    args: [params: { backend: CollaborationBackend }];
    result: void;
  };

  // ============ Project Conversations ============
  [IpcChannel.ProjectConversation_Resolve]: {
    args: [params: ProjectConversationResolveParams];
    result: ProjectConversationBindingDTO | null;
  };
  [IpcChannel.ProjectConversation_List]: {
    args: [params: ProjectConversationListParams];
    result: ProjectConversationBindingDTO[];
  };
  [IpcChannel.ProjectConversation_Create]: {
    args: [params: ProjectConversationCreateParams];
    result: ProjectConversationBindingDTO;
  };
  [IpcChannel.ProjectConversation_SetDefault]: {
    args: [params: ProjectConversationSetDefaultParams];
    result: { success: boolean };
  };
}
