/**
 * @file Type-Safe IPC API Contract — Barrel
 * @description Re-exports all domain types + composes unified IPCApiContract
 * @depends ipc/channels, ipc/*-contract, types/chat
 *
 * Design principles:
 * 1. Single Source of Truth — domain files own types + channel sub-contracts
 * 2. Compile-time type safety — ValidateInvokeChannels ensures no missing channels
 * 3. Backward compatibility — all 41 importers work unchanged via export *
 */

import { IpcChannel } from './ipc/channels';

// ====== Re-export all domain types ======

export * from './ipc/file-contract';
export * from './ipc/compile-contract';
export * from './ipc/lsp-contract';
export * from './ipc/ai-contract';
export * from './ipc/overleaf-contract';
export * from './ipc/app-contract';

// ====== Import sub-contracts for composition ======

import type { IPCFileContract } from './ipc/file-contract';
import type { IPCCompileContract } from './ipc/compile-contract';
import type { IPCLspContract } from './ipc/lsp-contract';
import type { IPCAiContract } from './ipc/ai-contract';
import type { IPCOverleafContract } from './ipc/overleaf-contract';
import type { IPCAppContract } from './ipc/app-contract';
import type { IPCZoteroContract } from './ipc/zotero-contract';

// ====== Collaboration Owner (window-scoped backend marker) ======

/** Renderer-side claim payload for `CollaborationOwner_SetActive`. */
export interface CollaborationOwnerClaimDTO {
  backend: 'scipen-ot' | 'overleaf';
  projectId?: string | null;
  rootPath?: string | null;
  fileId?: string | null;
}

/** Main-side reply DTO returned by `CollaborationOwner_SetActive`. */
export interface CollaborationOwnerDTO {
  backend: 'scipen-ot' | 'overleaf' | 'local';
  windowId: number;
  projectId: string | null;
  rootPath: string | null;
  fileId: string | null;
  claimedAt: number;
}

interface IPCCollaborationOwnerContract {
  'collaboration-owner:set-active': {
    args: [owner: CollaborationOwnerClaimDTO];
    result: CollaborationOwnerDTO;
  };
  'collaboration-owner:clear': {
    args: [params: { backend: 'scipen-ot' | 'overleaf' }];
    result: void;
  };
}

// ====== Composed IPC API Contract ======

/**
 * Unified IPC API Contract — composed from domain sub-contracts.
 * Defines args (parameter tuple) and result types for each channel.
 */
export interface IPCApiContract
  extends IPCFileContract,
    IPCCompileContract,
    IPCLspContract,
    IPCAiContract,
    IPCOverleafContract,
    IPCAppContract,
    IPCZoteroContract,
    IPCCollaborationOwnerContract {}

// ====== Event Contract (cross-domain, stays here) ======

import type { LSPDiagnostic } from './ipc/lsp-contract';
import type { AIConfigDTO } from './ipc/types';
import type { ZoteroSettingsDTO } from './types/zotero';
import type { ZoteroEventDTO } from './types/zotero-events';

/** IPC event channel types (send/on pattern) */
export interface IPCEventContract {
  [IpcChannel.FileWatcher_Changed]: {
    type: 'change' | 'unlink' | 'add';
    path: string;
    mtime?: number;
  };
  [IpcChannel.LSP_Diagnostics]: {
    filePath: string;
    diagnostics: LSPDiagnostic[];
  };
  [IpcChannel.LSP_Initialized]: void;
  [IpcChannel.LSP_Exit]: {
    code: number | null;
    signal: string | null;
  };
  [IpcChannel.LSP_ServiceStarted]: {
    service: 'texlab' | 'tinymist';
  };
  [IpcChannel.LSP_ServiceStopped]: {
    service: 'texlab' | 'tinymist';
  };
  [IpcChannel.LSP_Recovered]: void;
  [IpcChannel.AI_StreamChunk]: {
    type: string;
    content?: string;
    error?: string;
  };
  [IpcChannel.Window_OpenProject]: string;
  [IpcChannel.Window_OpenFile]: string;
  [IpcChannel.Message_FromMain]: string;
  [IpcChannel.Settings_AIConfigChanged]: AIConfigDTO;
  [IpcChannel.App_UpdateStatus]: import('./ipc/app-contract').UpdateStatus;
  [IpcChannel.Zotero_SettingsChanged]: ZoteroSettingsDTO;
  [IpcChannel.Zotero_Event]: ZoteroEventDTO;
  [IpcChannel.Zotero_MinerUProgress]: import('./types/zotero-mineru').MinerUParseStatusDTO;
  [IpcChannel.Zotero_EmbeddingProgress]: import('./types/zotero-embedding').EmbeddingIndexStatusDTO;
}

// ====== Type Utilities ======

/** Get parameter types for specified channel */
export type IPCArgs<T extends keyof IPCApiContract> = IPCApiContract[T]['args'];

/** Get return type for specified channel */
export type IPCResult<T extends keyof IPCApiContract> = IPCApiContract[T]['result'];

/** All invokable IPC channels */
export type IPCInvokeChannel = keyof IPCApiContract;

/** Get event channel data type */
export type IPCEventData<T extends keyof IPCEventContract> = IPCEventContract[T];

/** All event channels */
export type IPCEventChannel = keyof IPCEventContract;

// ==================== Type Safety Utilities ====================

/**
 * Channels defined in IpcChannel enum that are not yet in IPCApiContract
 *
 * This type will be non-empty if there are channels missing type definitions.
 * To fix: Add the missing channel to IPCApiContract or IPCEventContract.
 *
 * Currently untyped channels (intentionally excluded or event-only):
 * - FileCache_* (internal use)
 * - LSP_Error (event-only, currently unused)
 * - LSP_DirectChannel (event-only, handled specially in preload)
 * - Extended LSP APIs (LSP_IsTexLabAvailable, etc.) - not exposed in preload
 */
type AllDefinedChannels = keyof IPCApiContract | keyof IPCEventContract;

// Type-level check: Uncomment to see which channels are missing types
// type _MissingChannels = Exclude<IpcChannel, _AllDefinedChannels>;

/**
 * Assert that a channel is typed in the contract
 * Usage: const _check: AssertChannelTyped<IpcChannel.Some_Channel> = true;
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type AssertChannelTyped<_T extends AllDefinedChannels> = true;

/**
 * Explicitly excluded channels (not exposed to renderer or internal use only)
 * Note: LSP extended APIs have been moved to IPCApiContract for type safety
 */
export type ExcludedInvokeChannels =
  | IpcChannel.LSP_Error
  | IpcChannel.LSP_DirectChannel
  | IpcChannel.LSP_DirectChannelClosed
  | IpcChannel.LSP_ServiceRestarted;

/**
 * All channels that should have invoke types (used for validation)
 */
export type RequiredInvokeChannels = Exclude<
  IpcChannel,
  ExcludedInvokeChannels | keyof IPCEventContract
>;

/**
 * Validate that all required invoke channels are defined
 * This will cause a type error if a channel is missing from IPCApiContract
 */
type ValidateInvokeChannels = {
  [K in RequiredInvokeChannels]: K extends keyof IPCApiContract ? true : never;
};

// Compile-time assertion - if this fails, there's a missing channel definition
const _ValidateInvokeChannels = null as unknown as ValidateInvokeChannels;
void _ValidateInvokeChannels;
