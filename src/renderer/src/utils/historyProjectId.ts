/**
 * @file historyProjectId - derive a stable history projectId from `rootPath`.
 *
 * The `ProjectRuntimeContext.projectId` field is reserved for SNACA/OT and is
 * not populated on plain local-open paths; `rootPath` is the only stable
 * project identity available in the renderer. The history subsystem requires
 * `projectId` to match `/^[A-Za-z0-9_-]{1,128}$/` for path-traversal safety
 * (see `HistoryManager.PROJECT_ID_RX`), so we hash the normalized lowercase
 * rootPath into a 32-hex-char id.
 *
 * Same FNV-derived recipe as `makeProjectIdFromPath` in `agentHandlers.ts` so
 * a future main↔renderer cross-check stays trivial — both sides land on the
 * same id for the same workspace.
 */

export function historyProjectIdOf(rootPath: string | null | undefined): string {
  if (!rootPath) return '';
  const norm = rootPath.replace(/\\/g, '/').toLowerCase();
  return uuidV4ish(norm);
}

function uuidV4ish(input: string): string {
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0xdeadbeef >>> 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  const h1Hex = h1.toString(16).padStart(8, '0');
  const h2Hex = h2.toString(16).padStart(8, '0');
  // 32 hex chars total — well under the 128-char cap and the regex allows it.
  return `${h1Hex}${h2Hex}${h1Hex}${h2Hex}`;
}
