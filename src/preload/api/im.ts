import { ipcRenderer } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import type {
  IMConnectionStateDTO,
  IMErrorDTO,
  IMMessagesChangedDTO,
  IMSnapshot,
  IMTypingDTO,
  StudioIMConnectParams,
  StudioIMConversationDTO,
  StudioIMConversationMemberDTO,
  StudioIMCreateConversationParams,
  StudioIMListConversationsParams,
  StudioIMMessageDTO,
  StudioIMSendMessageParams,
  StudioIMUploadAttachmentParams,
  StudioIMUploadAttachmentResult,
} from '../../../shared/api-types';
import { createSafeListener } from './_shared';

export const imApi = {
  connect: (config: StudioIMConnectParams) =>
    ipcRenderer.invoke(IpcChannel.IM_Connect, config) as Promise<IMSnapshot>,
  disconnect: () => ipcRenderer.invoke(IpcChannel.IM_Disconnect) as Promise<void>,
  getSnapshot: () => ipcRenderer.invoke(IpcChannel.IM_GetSnapshot) as Promise<IMSnapshot>,
  listConversations: (params: StudioIMListConversationsParams) =>
    ipcRenderer.invoke(IpcChannel.IM_ListConversations, params) as Promise<
      StudioIMConversationDTO[]
    >,
  createConversation: (params: StudioIMCreateConversationParams) =>
    ipcRenderer.invoke(
      IpcChannel.IM_CreateConversation,
      params
    ) as Promise<StudioIMConversationDTO>,
  getConversationMembers: (baseUrl: string, token: string, conversationId: string) =>
    ipcRenderer.invoke(
      IpcChannel.IM_GetConversationMembers,
      baseUrl,
      token,
      conversationId
    ) as Promise<StudioIMConversationMemberDTO[]>,
  sendMessage: (params: StudioIMSendMessageParams) =>
    ipcRenderer.invoke(IpcChannel.IM_SendMessage, params) as Promise<StudioIMMessageDTO>,
  uploadAttachment: (params: StudioIMUploadAttachmentParams) =>
    ipcRenderer.invoke(
      IpcChannel.IM_UploadAttachment,
      params
    ) as Promise<StudioIMUploadAttachmentResult>,
  sendTyping: (conversationId: string) =>
    ipcRenderer.invoke(IpcChannel.IM_SendTyping, conversationId) as Promise<void>,
  getBotUserId: (baseUrl: string, token: string) =>
    ipcRenderer.invoke(IpcChannel.IM_GetBotUserId, baseUrl, token) as Promise<string>,
  onStateChanged: createSafeListener<IMConnectionStateDTO>(IpcChannel.IM_StateChanged),
  onMessagesChanged: createSafeListener<IMMessagesChangedDTO>(IpcChannel.IM_MessagesChanged),
  onTypingChanged: createSafeListener<IMTypingDTO>(IpcChannel.IM_TypingChanged),
  onError: createSafeListener<IMErrorDTO>(IpcChannel.IM_Error),
};
