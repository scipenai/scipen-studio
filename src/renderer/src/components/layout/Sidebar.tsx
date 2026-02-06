/**
 * @file Sidebar.tsx - Main Sidebar Navigation
 * @description App main navigation bar with file, chat, knowledge base entry icons
 */

import { clsx } from 'clsx';
import { motion } from 'framer-motion';
import type React from 'react';
import { memo } from 'react';
import logoS from '../../assets/logo-s.svg';
import { getUIService } from '../../services/core/ServiceRegistry';
import { ViewLocation } from '../../services/core/ViewRegistry';
import { useProjectPath, useSidebarTab, useViews } from '../../services/core/hooks';

interface SidebarItemProps {
  icon: React.ReactNode;
  label: string;
  isActive: boolean;
  onClick: () => void;
}

// Use memo to optimize: only re-render when isActive changes
const SidebarItem: React.FC<SidebarItemProps> = memo(({ icon, label, isActive, onClick }) => (
  <button
    onClick={onClick}
    className={clsx(
      'group relative w-12 h-12 flex items-center justify-center rounded-xl transition-all duration-200 cursor-pointer',
      isActive
        ? 'text-[var(--color-accent)]'
        : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]'
    )}
    style={{
      background: isActive ? 'var(--color-accent-muted)' : undefined,
      border: isActive ? '1px solid var(--color-border)' : '1px solid transparent',
    }}
    title={label}
  >
    {/* Icon with consistent styling */}
    <span
      className={clsx(
        'transition-all duration-200 flex items-center justify-center',
        isActive && 'drop-shadow-[0_0_6px_var(--color-accent)]'
      )}
    >
      {icon}
    </span>

    {/* Active state indicator - gradient bar */}
    <motion.div
      initial={false}
      animate={{
        opacity: isActive ? 1 : 0,
        scaleY: isActive ? 1 : 0,
        x: isActive ? 0 : -8,
      }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-7 rounded-r-full"
      style={{
        background: 'var(--gradient-accent)',
        boxShadow: isActive ? '0 0 12px var(--welcome-glow-primary)' : 'none',
      }}
    />

    {/* Tooltip */}
    <div
      className="absolute left-full ml-3 px-2.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap
                    opacity-0 invisible group-hover:opacity-100 group-hover:visible
                    transition-all duration-200 pointer-events-none z-50"
      style={{
        background: 'var(--color-bg-elevated)',
        border: '1px solid var(--color-border)',
        color: 'var(--color-text-primary)',
        boxShadow: 'var(--shadow-lg)',
      }}
    >
      {label}
      {/* Arrow */}
      <div
        className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1 w-2 h-2 rotate-45"
        style={{
          background: 'var(--color-bg-elevated)',
          borderLeft: '1px solid var(--color-border)',
          borderBottom: '1px solid var(--color-border)',
        }}
      />
    </div>
  </button>
));

export const Sidebar: React.FC = () => {
  const sidebarTab = useSidebarTab();
  const projectPath = useProjectPath();

  // Get views from ViewRegistry (dynamically registered)
  const views = useViews(ViewLocation.Sidebar);

  // Hide border on welcome screen (no project loaded)
  const isWelcomeScreen = !projectPath;

  return (
    <div
      className={clsx('w-16 flex flex-col items-center py-4', isWelcomeScreen && 'bg-transparent')}
      style={{
        background: isWelcomeScreen ? 'transparent' : 'var(--color-bg-void)',
        borderRight: isWelcomeScreen ? 'none' : '1px solid var(--color-border-subtle)',
      }}
    >
      {/* Logo */}
      <motion.div className="mb-6" whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
        <div className="w-11 h-11 flex items-center justify-center cursor-pointer">
          <img src={logoS} alt="SciPen" className="w-7 h-7" />
        </div>
      </motion.div>

      {/* Navigation items - dynamically retrieved from ViewRegistry */}
      <nav className="flex-1 flex flex-col gap-2">
        {views.map((view) => {
          const IconComponent = view.icon;
          return (
            <SidebarItem
              key={view.id}
              icon={<IconComponent size={22} />}
              label={view.name}
              isActive={sidebarTab === view.id}
              onClick={() => getUIService().setSidebarTab(view.id)}
            />
          );
        })}
      </nav>
    </div>
  );
};
