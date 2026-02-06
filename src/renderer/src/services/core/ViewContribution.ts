/**
 * @file ViewContribution.ts - Built-in View Registration
 * @description Registers all built-in sidebar views (Files, Knowledge Base, AI, etc.) on application startup
 * @depends ViewRegistry, React
 */

import { BookOpen, Bot, Files, MessageSquare, Settings, Wrench } from 'lucide-react';
import type { IDisposable } from '../../../../../shared/utils';
import { ViewLocation, type ViewRegistry } from './ViewRegistry';

// Lazy load component imports (avoid circular dependencies)
import React from 'react';

// ====== Built-in View ID Constants ======

export const BuiltinViews = {
  FILES: 'files',
  KNOWLEDGE: 'knowledge',
  AI: 'ai',
  TOOLS: 'tools',
  AI_CONFIG: 'aiconfig',
  SETTINGS: 'settings',
} as const;

export type BuiltinViewId = (typeof BuiltinViews)[keyof typeof BuiltinViews];

// ====== Lazy Load Component Wrappers ======

/**
 * Create lazy-loaded components
 * Avoid loading all panel components immediately on registration
 */
const LazyFileExplorer = React.lazy(() =>
  import('../../components/FileExplorer').then((m) => ({ default: m.FileExplorer }))
);

const LazyKnowledgePanel = React.lazy(() =>
  import('../../components/KnowledgePanel').then((m) => ({ default: m.KnowledgePanel }))
);

// ChatPanel supports Ask mode
const LazyChatPanel = React.lazy(() =>
  import('../../components/ChatPanel').then((m) => ({ default: m.ChatPanel }))
);

// ToolsPanel manual tools panel
const LazyToolsPanel = React.lazy(() =>
  import('../../components/ToolsPanel').then((m) => ({ default: m.ToolsPanel }))
);

const LazyAIConfigPanel = React.lazy(() =>
  import('../../components/settings/ai/AIConfigPanel').then((m) => ({ default: m.AIConfigPanel }))
);

const LazySettingsPanel = React.lazy(() =>
  import('../../components/SettingsPanel').then((m) => ({ default: m.SettingsPanel }))
);

// ====== Registration Function ======

/**
 * Register all built-in views
 *
 * @param registry ViewRegistry instance
 * @returns IDisposable for deregistering all built-in views
 */
export function registerBuiltinViews(registry: ViewRegistry): IDisposable {
  return registry.registerViews([
    // ====== Primary Views (Primary Group) ======
    {
      id: BuiltinViews.FILES,
      name: '文件',
      icon: Files,
      order: 100,
      component: LazyFileExplorer,
      location: ViewLocation.Sidebar,
      group: 'primary',
    },
    {
      id: BuiltinViews.KNOWLEDGE,
      name: '知识库',
      icon: BookOpen,
      order: 200,
      component: LazyKnowledgePanel,
      location: ViewLocation.Sidebar,
      group: 'primary',
    },
    {
      id: BuiltinViews.AI,
      name: '对话',
      icon: MessageSquare,
      order: 300,
      component: LazyChatPanel,
      location: ViewLocation.Sidebar,
      group: 'primary',
    },
    {
      id: BuiltinViews.TOOLS,
      name: '工具',
      icon: Wrench,
      order: 400,
      component: LazyToolsPanel,
      location: ViewLocation.Sidebar,
      group: 'primary',
    },

    // ====== Secondary Views (Secondary Group) ======
    {
      id: BuiltinViews.AI_CONFIG,
      name: 'AI 配置',
      icon: Bot,
      order: 500,
      component: LazyAIConfigPanel,
      location: ViewLocation.Sidebar,
      group: 'secondary',
    },
    {
      id: BuiltinViews.SETTINGS,
      name: '设置',
      icon: Settings,
      order: 600,
      component: LazySettingsPanel,
      location: ViewLocation.Sidebar,
      group: 'secondary',
    },
  ]);
}
