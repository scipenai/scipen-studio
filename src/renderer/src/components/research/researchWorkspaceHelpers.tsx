/**
 * @file researchWorkspaceHelpers.tsx
 * @description ResearchWorkspaceShell 的布局小件。主页面拍平为单层三面板
 *   (chat / editor / preview)后,这里只保留浅色分隔的 resize handle 与默认尺寸常量;
 *   旧的按 workspaceMode 推导宽度的逻辑随线性 mode 机一并移除。
 */

import { PanelResizeHandle } from 'react-resizable-panels';

/** 三面板默认占比(autoSaveId 持久化后以存储为准)。 */
export const PANEL_DEFAULT_SIZE = {
  chat: 30,
  editor: 44,
  preview: 26,
} as const;

/**
 * 浅色分隔条:静默 1px border-subtle 细线,hover 才显 accent。
 *
 * **必须常驻**(不要按面板可见性条件挂载/卸载)—— 三面板常驻 + collapsible 时,
 * 增删 handle 会破坏 react-resizable-panels 的子结构稳定性,首挂载帧 handle 注册
 * 错乱(表现:相邻面板间分隔线不渲染,需手动 toggle 才出现)。这里恒渲染,
 * 仅用 `active` 切换可见线与可拖性:不活动时宽度 0、无线、disabled。
 */
export const WorkspaceResizeHandle = ({ active = true }: { active?: boolean }) => (
  <PanelResizeHandle
    disabled={!active}
    className={`group relative bg-transparent transition-colors ${active ? 'w-2' : 'w-0'}`}
  >
    {active && (
      <>
        <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[var(--color-border-subtle)] transition-colors group-hover:bg-[var(--color-accent)]" />
        <div className="absolute left-1/2 top-1/2 h-10 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-transparent transition-colors group-hover:bg-[var(--color-accent-muted)]" />
      </>
    )}
  </PanelResizeHandle>
);
