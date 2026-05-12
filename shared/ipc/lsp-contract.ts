/**
 * @file LSP IPC Contract
 * @description Language Server Protocol types and channel contract
 * @depends ipc/channels
 */

import { IpcChannel } from './channels';

// ====== LSP Types ======

export interface LSPProcessInfo {
  mode: string;
  processAlive: boolean;
  initialized: boolean;
}

export interface LSPStartOptions {
  virtual?: boolean;
}

export interface LSPDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity?: number;
  message: string;
  source?: string;
}

export interface LSPCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { kind: string; value: string };
  insertText?: string;
  insertTextFormat?: number;
}

export interface LSPHover {
  contents:
    | string
    | { kind: string; value: string }
    | Array<string | { kind: string; value: string }>;
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

export interface LSPLocation {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

export interface LSPDocumentSymbol {
  name: string;
  kind: number;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  selectionRange: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  children?: LSPDocumentSymbol[];
}

export interface LSPSemanticTokens {
  resultId?: string | null;
  data: number[];
  legend: {
    tokenTypes: string[];
    tokenModifiers: string[];
  };
}

export interface LSPTextChange {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  rangeLength?: number;
  text: string;
}

// ====== Channel Contract ======

export interface IPCLspContract {
  [IpcChannel.LSP_GetProcessInfo]: {
    args: [];
    result: LSPProcessInfo;
  };
  [IpcChannel.LSP_IsAvailable]: {
    args: [];
    result: boolean;
  };
  [IpcChannel.LSP_GetVersion]: {
    args: [];
    result: string | null;
  };
  [IpcChannel.LSP_Start]: {
    args: [rootPath: string, options?: LSPStartOptions];
    result: boolean;
  };
  [IpcChannel.LSP_Stop]: {
    args: [];
    result: void;
  };
  [IpcChannel.LSP_IsRunning]: {
    args: [];
    result: boolean;
  };
  [IpcChannel.LSP_IsVirtualMode]: {
    args: [];
    result: boolean;
  };
  [IpcChannel.LSP_OpenDocument]: {
    args: [filePath: string, content: string, languageId?: string];
    result: void;
  };
  [IpcChannel.LSP_UpdateDocument]: {
    args: [filePath: string, content: string];
    result: void;
  };
  [IpcChannel.LSP_UpdateDocumentIncremental]: {
    args: [filePath: string, changes: LSPTextChange[]];
    result: void;
  };
  [IpcChannel.LSP_CloseDocument]: {
    args: [filePath: string];
    result: void;
  };
  [IpcChannel.LSP_SaveDocument]: {
    args: [filePath: string];
    result: void;
  };
  [IpcChannel.LSP_GetCompletions]: {
    args: [filePath: string, line: number, character: number];
    result: LSPCompletionItem[];
  };
  [IpcChannel.LSP_GetHover]: {
    args: [filePath: string, line: number, character: number];
    result: LSPHover | null;
  };
  [IpcChannel.LSP_GetDefinition]: {
    args: [filePath: string, line: number, character: number];
    result: LSPLocation | LSPLocation[] | null;
  };
  [IpcChannel.LSP_GetReferences]: {
    args: [filePath: string, line: number, character: number, includeDeclaration?: boolean];
    result: LSPLocation[];
  };
  [IpcChannel.LSP_GetSymbols]: {
    args: [filePath: string];
    result: LSPDocumentSymbol[];
  };
  [IpcChannel.LSP_GetSemanticTokens]: {
    args: [filePath: string];
    result: LSPSemanticTokens | null;
  };
  [IpcChannel.LSP_Build]: {
    args: [filePath: string];
    result: { success: boolean; error?: string };
  };
  [IpcChannel.LSP_ForwardSearch]: {
    args: [filePath: string, line: number];
    result: { success: boolean; error?: string };
  };
  [IpcChannel.LSP_RequestDirectChannel]: {
    args: [];
    result: { success: boolean; error?: string };
  };
  [IpcChannel.LSP_StartAll]: {
    args: [rootPath: string, options?: { virtual?: boolean }];
    result: { texlab: boolean; tinymist: boolean; marksman: boolean };
  };
  [IpcChannel.LSP_StartTexLab]: {
    args: [rootPath: string, options?: { virtual?: boolean }];
    result: boolean;
  };
  [IpcChannel.LSP_StartTinymist]: {
    args: [rootPath: string, options?: { virtual?: boolean }];
    result: boolean;
  };
  [IpcChannel.LSP_StartMarksman]: {
    args: [rootPath: string, options?: { virtual?: boolean }];
    result: boolean;
  };
  [IpcChannel.LSP_ExportTypstPdf]: {
    args: [filePath: string];
    result: { success: boolean; pdfPath?: string; error?: string };
  };
  [IpcChannel.LSP_FormatTypst]: {
    args: [filePath: string];
    result: { edits: unknown[] };
  };
  [IpcChannel.LSP_IsTexLabAvailable]: {
    args: [];
    result: boolean;
  };
  [IpcChannel.LSP_IsTinymistAvailable]: {
    args: [];
    result: boolean;
  };
  [IpcChannel.LSP_IsMarksmanAvailable]: {
    args: [];
    result: boolean;
  };
  [IpcChannel.LSP_CheckAvailability]: {
    args: [];
    result: {
      texlab: boolean;
      tinymist: boolean;
      marksman: boolean;
      texlabVersion?: string;
      tinymistVersion?: string;
      marksmanVersion?: string;
    };
  };
  [IpcChannel.LSP_GetTexLabVersion]: {
    args: [];
    result: string | undefined;
  };
  [IpcChannel.LSP_GetTinymistVersion]: {
    args: [];
    result: string | undefined;
  };
  [IpcChannel.LSP_GetMarksmanVersion]: {
    args: [];
    result: string | undefined;
  };
}
