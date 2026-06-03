/**
 * @file AI/Chat/Settings IPC Contract
 * @description AI, Chat, Settings, Selection types and channel contract
 * @depends ipc/channels, ipc/types, types/chat
 */

import { IpcChannel } from './channels';
import type {
  AIConfigDTO,
  AIProviderDTO,
  SelectedModels,
  SelectionCaptureDTO,
  SelectionConfigDTO,
} from './types';
// ====== AI Types ======

export interface AIConfig {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  completionModel?: string;
  polishModel?: string;
}

export interface AIResult {
  success: boolean;
  content?: string;
  result?: string; // @deprecated Use content instead
  error?: string;
}

export interface AITestResult {
  success: boolean;
  message: string;
}

/** @deprecated Use ChatMessage from types/chat instead */
export interface AIChatMessage {
  role: string;
  content: string;
}

// ====== Channel Contract ======

export interface IPCAiContract {
  // ============ AI ============
  [IpcChannel.AI_UpdateConfig]: {
    args: [config: AIConfig];
    result: { success: boolean };
  };
  [IpcChannel.AI_IsConfigured]: {
    args: [];
    result: boolean;
  };
  [IpcChannel.AI_Completion]: {
    args: [context: string];
    result: AIResult;
  };
  [IpcChannel.AI_ChatStream]: {
    args: [messages: AIChatMessage[]];
    result: { success: boolean; error?: string };
  };
  [IpcChannel.AI_TestConnection]: {
    args: [];
    result: AITestResult;
  };
  [IpcChannel.AI_StopGeneration]: {
    args: [];
    result: { success: boolean };
  };
  [IpcChannel.AI_IsGenerating]: {
    args: [];
    result: boolean;
  };
  [IpcChannel.AI_FetchModels]: {
    args: [baseUrl: string, apiKey?: string];
    result: {
      success: boolean;
      models?: Array<{ id: string; object?: string; owned_by?: string; created?: number }>;
      error?: string;
    };
  };

  // ============ Chat ============ removed in P4-C (SNACA is the only chat runtime)

  // ============ Settings (AI Providers) ============
  [IpcChannel.Settings_GetAIProviders]: {
    args: [];
    result: AIProviderDTO[];
  };
  [IpcChannel.Settings_SetAIProviders]: {
    args: [providers: AIProviderDTO[]];
    result: { success: boolean };
  };
  [IpcChannel.Settings_GetSelectedModels]: {
    args: [];
    result: SelectedModels;
  };
  [IpcChannel.Settings_SetSelectedModels]: {
    args: [models: SelectedModels];
    result: { success: boolean };
  };
  [IpcChannel.Settings_GetAIConfig]: {
    args: [];
    result: AIConfigDTO;
  };
  [IpcChannel.Settings_SetAIConfig]: {
    args: [config: AIConfigDTO];
    result: { success: boolean };
  };

  // ============ Selection Assistant ============
  [IpcChannel.Selection_SetEnabled]: {
    args: [enabled: boolean];
    result: { success: boolean; error?: string };
  };
  [IpcChannel.Selection_IsEnabled]: {
    args: [];
    result: boolean;
  };
  [IpcChannel.Selection_GetConfig]: {
    args: [];
    result: SelectionConfigDTO | null;
  };
  [IpcChannel.Selection_SetConfig]: {
    args: [config: Partial<SelectionConfigDTO>];
    result: { success: boolean; error?: string };
  };
  [IpcChannel.Selection_GetText]: {
    args: [];
    result: SelectionCaptureDTO | null;
  };
}
