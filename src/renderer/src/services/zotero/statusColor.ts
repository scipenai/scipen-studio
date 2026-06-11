/**
 * @file statusColor.ts -- BibStatus -> CSS variable color mapping.
 * @description Shared dictionary for Mirror UI. StatusBar badge and Settings
 *              status card both depend on it. Adding a new BibStatus only
 *              requires editing here; all render sites stay in sync.
 */

import type { BibStatus } from '../../../../../shared/types/zotero-events';

export const BIB_STATUS_COLOR: Record<BibStatus, string> = {
  idle: 'var(--color-text-disabled)',
  bootstrapping: 'var(--color-accent)',
  syncing: 'var(--color-accent)',
  ready: 'var(--color-success)',
  degraded: 'var(--color-warning)',
  error: 'var(--color-error)',
};

export function isBibStatusBusy(status: BibStatus): boolean {
  return status === 'bootstrapping' || status === 'syncing';
}
