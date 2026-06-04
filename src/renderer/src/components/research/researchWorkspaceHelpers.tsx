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
 * 卡片间隙分隔条:浮动卡片布局下,分隔条本身就是「间隙」—— 透明,露出底层
 * canvas,不再画 1px 拼接细线(卡片各自带边框)。仅 hover 时显一截 accent 把手
 * 提示可拖拽。
 *
 * 仅渲染在两个**可见**面板之间(由 ResearchWorkspaceShell 按可见面板列表声明式
 * 插入)—— 面板与分隔条的增删始终一致,无需常驻或 active 开关。
 */
export const WorkspaceResizeHandle = () => (
  <PanelResizeHandle className="group relative w-3 bg-transparent transition-colors">
    <div className="absolute left-1/2 top-1/2 h-10 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-transparent transition-colors group-hover:bg-[var(--color-accent-muted)]" />
  </PanelResizeHandle>
);
