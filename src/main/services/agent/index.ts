/**
 * @file Agent subsystem public surface.
 *
 * Exports `SnacaSidecarService`, `EditorProtocolClient`, and the protocol
 * type layer. Renderer-facing IPC handlers (next phase) consume these.
 */

export * from './interfaces';
export * from './protocol';
export {
  createSnacaSidecarService,
  SnacaSidecarService,
} from './SnacaSidecarService';
export {
  createEditorProtocolClient,
  EditorProtocolClient,
} from './EditorProtocolClient';
export {
  createAgentEditApplyService,
  AgentEditApplyService,
} from './AgentEditApplyService';
export {
  createContextRequestService,
  ContextRequestService,
  defaultGetRendererWebContents,
} from './ContextRequestService';
