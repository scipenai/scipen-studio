/**
 * @file clipboard.ts - Module-level clipboard state for file explorer copy/cut operations
 * @description Shared clipboard state accessed by ContextMenu, useFileOperations, and command handlers.
 */

// Internal copy/cut state for the file explorer — not synced with the system clipboard.
let clipboardItem: {
  path: string;
  name: string;
  type: 'file' | 'directory';
  operation: 'copy' | 'cut';
} | null = null;

export function getClipboardItem() {
  return clipboardItem;
}

export function setClipboardItem(item: typeof clipboardItem) {
  clipboardItem = item;
}
