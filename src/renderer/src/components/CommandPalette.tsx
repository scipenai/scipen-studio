/**
 * @file CommandPalette.tsx - Command Palette
 * @description Global quick command palette with search and fast operation execution
 */

import { AnimatePresence, motion } from 'framer-motion';
import {
  BookOpen,
  FileText,
  HelpCircle,
  MessageSquare,
  Play,
  Search,
  Settings,
  WandSparkles,
} from 'lucide-react';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useWindowEvent } from '../hooks';
import { useTranslation } from '../locales';
import { getUIService } from '../services/core';

interface Command {
  id: string;
  label: string;
  description?: string;
  icon: React.ReactNode;
  category: 'ai' | 'file' | 'edit' | 'view' | 'help';
  shortcut?: string;
  action: () => void;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({ isOpen, onClose }) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();

  const uiService = getUIService();

  const commands: Command[] = [
    {
      id: 'ai-polish',
      label: t('commandPalette.aiPolish'),
      description: t('commandPalette.aiPolishDesc'),
      icon: <WandSparkles size={16} />,
      category: 'ai',
      shortcut: 'Ctrl+Shift+P',
      action: () => {
        window.dispatchEvent(new CustomEvent('trigger-ai-polish'));
        onClose();
      },
    },
    {
      id: 'ai-chat',
      label: t('commandPalette.openAI'),
      description: t('commandPalette.openAIDesc'),
      icon: <MessageSquare size={16} />,
      category: 'ai',
      shortcut: 'Ctrl+Shift+C',
      action: () => {
        uiService.setSidebarTab('ai');
        onClose();
      },
    },
    {
      id: 'ai-review',
      label: t('commandPalette.aiReview'),
      description: t('commandPalette.aiReviewDesc'),
      icon: <BookOpen size={16} />,
      category: 'ai',
      action: () => {
        uiService.setRightPanelTab('review');
        onClose();
      },
    },
    {
      id: 'file-save',
      label: t('commandPalette.saveFile'),
      icon: <FileText size={16} />,
      category: 'file',
      shortcut: 'Ctrl+S',
      action: () => {
        const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true });
        window.dispatchEvent(event);
        onClose();
      },
    },
    {
      id: 'compile',
      label: t('commandPalette.compileDoc'),
      description: t('commandPalette.compileDocDesc'),
      icon: <Play size={16} />,
      category: 'file',
      shortcut: 'Ctrl+B',
      action: () => {
        window.dispatchEvent(new CustomEvent('trigger-compile'));
        onClose();
      },
    },
    {
      id: 'view-preview',
      label: t('commandPalette.showPdfPreview'),
      icon: <FileText size={16} />,
      category: 'view',
      action: () => {
        uiService.setRightPanelTab('preview');
        onClose();
      },
    },
    {
      id: 'view-knowledge',
      label: t('commandPalette.openKnowledge'),
      icon: <BookOpen size={16} />,
      category: 'view',
      action: () => {
        uiService.setSidebarTab('knowledge');
        onClose();
      },
    },

    {
      id: 'settings',
      label: t('commandPalette.openSettings'),
      icon: <Settings size={16} />,
      category: 'view',
      action: () => {
        uiService.setSidebarTab('settings');
        onClose();
      },
    },
    {
      id: 'help-shortcuts',
      label: t('commandPalette.showShortcuts'),
      icon: <HelpCircle size={16} />,
      category: 'help',
      action: () => {
        // TODO: Show shortcuts panel
        onClose();
      },
    },
  ];

  const filteredCommands = commands.filter(
    (cmd) =>
      cmd.label.toLowerCase().includes(query.toLowerCase()) ||
      cmd.description?.toLowerCase().includes(query.toLowerCase())
  );

  // useWindowEvent automatically manages event listeners
  useWindowEvent('keydown', (e: KeyboardEvent) => {
    if (!isOpen) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex((prev) => (prev < filteredCommands.length - 1 ? prev + 1 : prev));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
        break;
      case 'Enter':
        e.preventDefault();
        if (filteredCommands[selectedIndex]) {
          filteredCommands[selectedIndex].action();
        }
        break;
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
    }
  });

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      // Use requestAnimationFrame instead of setTimeout for faster response
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 bg-black/40 backdrop-blur-sm"
          onClick={onClose}
        />

        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: -20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -20 }}
          transition={{ duration: 0.15 }}
          className="relative w-full max-w-2xl backdrop-blur-xl rounded-2xl shadow-2xl overflow-hidden bg-[var(--color-bg-secondary)] border border-[var(--color-border)]"
        >
          <div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--color-border)]">
            <Search size={20} className="flex-shrink-0 text-[var(--color-text-secondary)]" />
            <input
              ref={inputRef}
              type="text"
              placeholder={t('commandPalette.placeholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="flex-1 bg-transparent outline-none text-base text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)]"
            />
            <kbd className="px-2 py-1 text-xs rounded text-[var(--color-text-secondary)] bg-[var(--color-bg-tertiary)]">
              esc
            </kbd>
          </div>

          <div className="max-h-[50vh] overflow-y-auto py-2">
            {filteredCommands.length === 0 ? (
              <div className="px-5 py-8 text-center text-[var(--color-text-secondary)]">
                {t('commandPalette.noResults')}
              </div>
            ) : (
              filteredCommands.map((cmd, index) => (
                <button
                  key={cmd.id}
                  onClick={cmd.action}
                  onMouseEnter={() => setSelectedIndex(index)}
                  className={`w-full px-5 py-3 flex items-center gap-4 transition-colors cursor-pointer ${
                    index === selectedIndex ? 'bg-[var(--color-bg-tertiary)]' : ''
                  }`}
                >
                  <div
                    className={`flex-shrink-0 ${
                      cmd.category === 'ai'
                        ? 'text-[var(--color-info)]'
                        : 'text-[var(--color-text-secondary)]'
                    }`}
                  >
                    {cmd.icon}
                  </div>
                  <div className="flex-1 text-left">
                    <div className="text-sm font-medium text-[var(--color-text-primary)]">
                      {cmd.label}
                    </div>
                    {cmd.description && (
                      <div className="text-xs mt-0.5 text-[var(--color-text-secondary)]">
                        {cmd.description}
                      </div>
                    )}
                  </div>
                  {cmd.shortcut && (
                    <kbd className="px-2 py-1 text-xs rounded text-[var(--color-text-secondary)] bg-[var(--color-bg-tertiary)]">
                      {cmd.shortcut}
                    </kbd>
                  )}
                </button>
              ))
            )}
          </div>

          <div className="px-5 py-3 flex items-center justify-between text-xs border-t border-[var(--color-border)] text-[var(--color-text-secondary)]">
            <div className="flex items-center gap-4">
              <span>
                <kbd className="px-1.5 py-0.5 rounded mr-1 bg-[var(--color-bg-tertiary)]">↑↓</kbd>
                {t('commandPalette.navigate')}
              </span>
              <span>
                <kbd className="px-1.5 py-0.5 rounded mr-1 bg-[var(--color-bg-tertiary)]">↵</kbd>
                {t('commandPalette.execute')}
              </span>
            </div>
            <span>{t('commandPalette.openPalette')}</span>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
