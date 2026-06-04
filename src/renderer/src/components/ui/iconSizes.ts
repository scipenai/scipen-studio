/**
 * @file iconSizes.ts — lucide-react 图标尺寸的统一约定。
 *
 * lucide 的 `size` 是数值 prop(非 CSS),无法走 CSS 变量收口。此处建立
 * 跨组件一致的尺寸刻度,替代散落的 `size={14|16|18}` 魔法值。迁移随各
 * 界面打磨阶段推进,本常量是底座。
 *
 * 取值与设计节奏对齐:
 *   xs(12) 行内/密集列表 · sm(14) 工具栏/设置项 · md(16) 主操作/命令面板
 *   lg(18) 区块标题 · xl(20) 空态/欢迎
 */
export const ICON = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  xl: 20,
} as const;

export type IconSize = (typeof ICON)[keyof typeof ICON];
