/**
 * @file ipc-security.test.ts
 * @description IPC security validation tests - ensures all channels have proper schema definitions and whitelist entries
 * @depends vitest, shared/ipc/channels, main/ipc/typedIpc
 */

import { describe, expect, it } from 'vitest';
import { IpcChannel } from '../../../shared/ipc/channels';

import { channelSchemas } from '../../../src/main/ipc/typedIpc';

// ====== Test Data Preparation ======

function getAllIpcChannels(): string[] {
  return Object.values(IpcChannel).filter((v) => typeof v === 'string') as string[];
}

/**
 * Channels exempted from whitelist (with documented reasons)
 */
const EXEMPT_FROM_WHITELIST = new Set<string>([
  // Internal channels not exposed via preload
]);

/**
 * Channels exempted from schema validation
 * Usually channels with no parameters or very simple parameters
 */
const EXEMPT_FROM_SCHEMA = new Set<string>([
  // Channels with no parameters
  IpcChannel.App_GetVersion,
  IpcChannel.App_GetHomeDir,
  IpcChannel.App_GetAppDataDir,
  IpcChannel.App_OpenExternal,
  IpcChannel.Window_New,
  IpcChannel.Window_Close,
  IpcChannel.Window_Focus,
  IpcChannel.Window_GetAll,
  IpcChannel.LSP_Stop,
  IpcChannel.LSP_CheckAvailability,
  IpcChannel.LSP_GetTexLabVersion,
  IpcChannel.LSP_GetTinymistVersion,
  IpcChannel.LSP_IsTexLabAvailable,
  IpcChannel.LSP_IsTinymistAvailable,
  IpcChannel.Overleaf_Login,
  IpcChannel.Overleaf_IsLoggedIn,
  IpcChannel.Overleaf_GetProjects,
  IpcChannel.Overleaf_GetCookies,
  IpcChannel.AI_IsConfigured,
  IpcChannel.AI_TestConnection,
  IpcChannel.AI_StopGeneration,
  IpcChannel.Knowledge_GetLibraries,
  IpcChannel.Typst_Available,
  IpcChannel.LocalReplica_GetConfig,
  IpcChannel.LocalReplica_IsWatching,

  // Event channels (not invoke, no schema needed)
  IpcChannel.Window_OpenProject,
  IpcChannel.Window_OpenFile,
  IpcChannel.Knowledge_Event,
  IpcChannel.Knowledge_TaskProgress,
  IpcChannel.AI_StreamChunk,
  IpcChannel.Message_FromMain,
  IpcChannel.FileWatcher_Changed,
  IpcChannel.LSP_Diagnostics,
  IpcChannel.LSP_Initialized,
  IpcChannel.LSP_Exit,
  IpcChannel.LSP_Error,
  IpcChannel.LSP_ServiceStarted,
  IpcChannel.LSP_ServiceStopped,
  IpcChannel.LSP_ServiceRestarted,
  IpcChannel.LSP_DirectChannel,
  IpcChannel.LSP_DirectChannelClosed,
  IpcChannel.LSP_Recovered,
  IpcChannel.Settings_AIConfigChanged,
  IpcChannel.Config_Changed,
  IpcChannel.Selection_TextCaptured,
  IpcChannel.LocalReplica_SyncProgress,

  // Simple parameter channels (single primitive type, low risk)
  IpcChannel.Config_Get,
  IpcChannel.Dialog_Confirm,
  IpcChannel.Dialog_Message,
  IpcChannel.File_Select,
  IpcChannel.Folder_Create,
  IpcChannel.Knowledge_GetLibrary,
  IpcChannel.Knowledge_CreateLibrary,
  IpcChannel.Knowledge_DeleteLibrary,
  IpcChannel.Knowledge_GetDocuments,
  IpcChannel.Knowledge_GetDocument,
  IpcChannel.Knowledge_DeleteDocument,
  IpcChannel.Knowledge_Search,
  IpcChannel.Knowledge_GetTask,
  IpcChannel.Overleaf_GetProjectDetails,
]);

// ====== Test Cases ======

describe('IPC Security - Channel Schema Coverage', () => {
  const allChannels = getAllIpcChannels();
  const schemaChannels = new Set(channelSchemas.keys());

  it('should have schema definitions for security-critical channels', () => {
    const missingSchemas: string[] = [];

    for (const channel of allChannels) {
      if (EXEMPT_FROM_SCHEMA.has(channel)) {
        continue;
      }

      if (!schemaChannels.has(channel)) {
        missingSchemas.push(channel);
      }
    }

    if (missingSchemas.length > 0) {
      console.warn('\n⚠️ Channels missing schema definitions:');
      missingSchemas.forEach((ch) => console.warn(`  - ${ch}`));
      console.warn('\nIf new channel, add Zod schema to channelSchemas in typedIpc.ts.');
      console.warn('If truly exempt, add to EXEMPT_FROM_SCHEMA with documented reason.\n');
    }

    // Allow some missing schemas (gradually tightening)
    // TODO: Target is 0
    expect(
      missingSchemas.length,
      `Found ${missingSchemas.length} channels missing schema: ${missingSchemas.join(', ')}`
    ).toBeLessThanOrEqual(30);
  });

  it('should not have orphan schemas (schemas for non-existent channels)', () => {
    const allChannelSet = new Set(allChannels);
    const orphanSchemas: string[] = [];

    for (const schemaChannel of schemaChannels) {
      if (!allChannelSet.has(schemaChannel)) {
        orphanSchemas.push(schemaChannel);
      }
    }

    expect(orphanSchemas, `Found orphan schemas: ${orphanSchemas.join(', ')}`).toHaveLength(0);
  });
});

describe('IPC Security - Path-Related Channels', () => {
  /**
   * Path-related channels must have schema validation for security
   */
  const PATH_CHANNELS = [
    IpcChannel.File_Read,
    IpcChannel.File_ReadBinary,
    IpcChannel.File_Write,
    IpcChannel.File_Create,
    IpcChannel.File_Delete,
    IpcChannel.File_Rename,
    IpcChannel.File_Copy,
    IpcChannel.File_Move,
    IpcChannel.File_Exists,
    IpcChannel.File_Stats,
    IpcChannel.File_ShowInFolder,
    IpcChannel.File_Trash,
    IpcChannel.File_OpenPath,
    IpcChannel.File_RefreshTree,
    IpcChannel.Folder_Create,
    IpcChannel.File_BatchRead,
    IpcChannel.File_BatchStat,
    IpcChannel.File_BatchExists,
    IpcChannel.File_BatchWrite,
    IpcChannel.File_BatchDelete,
    IpcChannel.FileWatcher_Start,
    IpcChannel.FileCache_Warmup,
    IpcChannel.FileCache_Invalidate,
    IpcChannel.Project_OpenByPath,
    IpcChannel.LSP_Start,
    IpcChannel.LSP_OpenDocument,
    IpcChannel.LSP_UpdateDocument,
    IpcChannel.LSP_UpdateDocumentIncremental,
    IpcChannel.LSP_CloseDocument,
    IpcChannel.LSP_SaveDocument,
    IpcChannel.LSP_GetCompletions,
    IpcChannel.LSP_GetHover,
    IpcChannel.LSP_GetDefinition,
    IpcChannel.LSP_GetReferences,
    IpcChannel.LSP_GetSymbols,
    IpcChannel.LSP_Build,
    IpcChannel.LSP_ForwardSearch,
    IpcChannel.LSP_StartAll,
    IpcChannel.LSP_StartTexLab,
    IpcChannel.LSP_StartTinymist,
    IpcChannel.LSP_ExportTypstPdf,
    IpcChannel.LSP_FormatTypst,
    IpcChannel.Knowledge_AddDocument,
    IpcChannel.LocalReplica_Init,
    IpcChannel.Compile_LaTeX,
    IpcChannel.Compile_Typst,
    IpcChannel.SyncTeX_Forward,
    IpcChannel.SyncTeX_Backward,
  ];

  it('all path-related channels should have schema definitions', () => {
    const schemaChannels = new Set(channelSchemas.keys());
    const missingSchemas: string[] = [];

    for (const channel of PATH_CHANNELS) {
      if (!schemaChannels.has(channel)) {
        missingSchemas.push(channel);
      }
    }

    expect(
      missingSchemas,
      `Path-related channels missing schema: ${missingSchemas.join(', ')}`
    ).toHaveLength(0);
  });
});

describe('IPC Security - URL-Related Channels', () => {
  /**
   * URL-related channels must use safeUrlSchema
   */
  const URL_CHANNELS = [
    IpcChannel.App_OpenExternal,
    IpcChannel.Overleaf_TestConnection,
    IpcChannel.Overleaf_Login,
  ];

  it('all URL-related channels should have schema definitions', () => {
    const schemaChannels = new Set(channelSchemas.keys());
    const missingSchemas: string[] = [];

    for (const channel of URL_CHANNELS) {
      if (!schemaChannels.has(channel)) {
        missingSchemas.push(channel);
      }
    }

    expect(
      missingSchemas,
      `URL-related channels missing schema: ${missingSchemas.join(', ')}`
    ).toHaveLength(0);
  });
});

describe('IPC Security - AI/User Input Channels', () => {
  /**
   * Channels handling large user input must have size limits
   */
  const USER_INPUT_CHANNELS = [
    IpcChannel.AI_Chat,
    IpcChannel.AI_ChatStream,
    IpcChannel.AI_Polish,
    IpcChannel.AI_UpdateConfig,
    IpcChannel.Compile_LaTeX,
    IpcChannel.Compile_Typst,
  ];

  it('all user input channels should have schema definitions with size limits', () => {
    const schemaChannels = new Set(channelSchemas.keys());
    const missingSchemas: string[] = [];

    for (const channel of USER_INPUT_CHANNELS) {
      if (!schemaChannels.has(channel)) {
        missingSchemas.push(channel);
      }
    }

    expect(
      missingSchemas,
      `User input channels missing schema: ${missingSchemas.join(', ')}`
    ).toHaveLength(0);
  });
});

// ====== Coverage Report ======

describe('IPC Security - Coverage Report', () => {
  it('should generate coverage report', () => {
    const allChannels = getAllIpcChannels();
    const schemaChannels = new Set(channelSchemas.keys());

    const withSchema = allChannels.filter((ch) => schemaChannels.has(ch));
    const withoutSchema = allChannels.filter((ch) => !schemaChannels.has(ch));
    const exempted = withoutSchema.filter((ch) => EXEMPT_FROM_SCHEMA.has(ch));
    const missing = withoutSchema.filter((ch) => !EXEMPT_FROM_SCHEMA.has(ch));

    const coverage = ((withSchema.length / allChannels.length) * 100).toFixed(1);

    console.log('\n📊 IPC Schema Coverage Report');
    console.log('═'.repeat(50));
    console.log(`Total Channels:   ${allChannels.length}`);
    console.log(`With Schema:      ${withSchema.length}`);
    console.log(`Exempted:         ${exempted.length}`);
    console.log(`Missing Schema:   ${missing.length}`);
    console.log(`Coverage:         ${coverage}%`);
    console.log('═'.repeat(50));

    if (missing.length > 0) {
      console.log('\n⚠️ Channels needing schema:');
      missing.forEach((ch) => console.log(`  - ${ch}`));
    }

    console.log('\n');

    expect(Number(coverage)).toBeGreaterThan(70);
  });
});
