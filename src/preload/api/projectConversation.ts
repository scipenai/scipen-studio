import { ipcRenderer } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import type {
  ProjectConversationBindingDTO,
  ProjectConversationBindingChangedEvent,
  ProjectConversationCreateParams,
  ProjectConversationListParams,
  ProjectConversationResolveParams,
  ProjectConversationSetDefaultParams,
} from '../../../shared/api-types';
import { createSafeListener } from './_shared';

export const projectConversationApi = {
  resolve: (params: ProjectConversationResolveParams) =>
    ipcRenderer.invoke(
      IpcChannel.ProjectConversation_Resolve,
      params
    ) as Promise<ProjectConversationBindingDTO | null>,
  list: (params: ProjectConversationListParams) =>
    ipcRenderer.invoke(IpcChannel.ProjectConversation_List, params) as Promise<
      ProjectConversationBindingDTO[]
    >,
  create: (params: ProjectConversationCreateParams) =>
    ipcRenderer.invoke(
      IpcChannel.ProjectConversation_Create,
      params
    ) as Promise<ProjectConversationBindingDTO>,
  setDefault: (params: ProjectConversationSetDefaultParams) =>
    ipcRenderer.invoke(IpcChannel.ProjectConversation_SetDefault, params) as Promise<{
      success: boolean;
    }>,
  onBindingChanged: createSafeListener<ProjectConversationBindingChangedEvent>(
    IpcChannel.ProjectConversation_BindingChanged
  ),
};
