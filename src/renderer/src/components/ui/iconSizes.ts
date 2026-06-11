/**
 * @file iconSizes.ts — unified size convention for lucide-react icons.
 *
 * lucide's `size` is a numeric prop (not CSS), so it cannot be funneled through
 * a CSS variable. This module establishes a cross-component size scale to replace
 * scattered magic values like `size={14|16|18}`. Migration proceeds alongside each
 * UI polish phase; this constant is the foundation.
 *
 * Values are aligned with the design rhythm:
 *   xs(12) inline / dense lists  -  sm(14) toolbars / settings rows  -  md(16) primary actions / command palette
 *   lg(18) section headers  -  xl(20) empty states / welcome
 */
export const ICON = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  xl: 20,
} as const;

export type IconSize = (typeof ICON)[keyof typeof ICON];
