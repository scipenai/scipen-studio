/**
 * @file statusColor.ts —— BibStatus → CSS 变量 颜色映射
 * @description Mirror UI 共享字典。StatusBar 徽章、Settings 状态卡都依赖。
 *              新增 BibStatus 时仅改这一处,自动同步全屏渲染点。
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
