/**
 * @file CommandPalette.tsx - Command Palette
 * @description Global quick command palette with search and fast operation execution
 */

import { AnimatePresence, motion } from 'framer-motion';
import {
  FileText,
  History,
  HelpCircle,
  MessageSquare,
  Play,
  Search,
  Settings,
  Tag,
} from 'lucide-react';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useWindowEvent } from '../hooks';
import { useTranslation } from '../locales';
import { getUIService } from '../services/core';
import { historyUIBus } from '../services/core/HistoryUIBus';

interface Command {
  id: string;
  label: string;
  description?: string;
  icon: React.ReactNode;
  category: 'ai' | 'file' | 'edit' | 'view' | 'help' | 'history';
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
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const { t } = useTranslation();

  const uiService = getUIService();

  const commands: Command[] = [
    {
      id: 'ai-chat',
      label: t('commandPalette.openAI'),
      description: t('commandPalette.openAIDesc'),
      icon: <MessageSquare size={16} />,
      category: 'ai',
      shortcut: 'Ctrl+L',
      action: () => {
        uiService.requestChatWithText('', 'editor');
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
      id: 'history-create-label',
      label: t('history.createLabel'),
      description: t('history.createLabelDesc'),
      icon: <Tag size={16} />,
      category: 'history',
      action: () => {
        onClose();
        historyUIBus.openCreateLabel();
      },
    },
    {
      // Single unified entry — mirrors the single sidebar History button.
      // Dialog has internal tabs for labels vs sessions; users can pick
      // either after the dialog opens.
      id: 'history-browse',
      label: t('history.browserTitle'),
      description: t('history.browseLabelsDesc'),
      icon: <History size={16} />,
      category: 'history',
      action: () => {
        onClose();
        historyUIBus.openBrowseLabels();
      },
    },
    {
      id: 'help-shortcuts',
      label: t('commandPalette.showShortcuts'),
      icon: <HelpCircle size={16} />,
      category: 'help',
      action: () => {
        onClose();
      },
    },
  ];

  const filteredCommands = commands.filter(
    (cmd) =>
      cmd.label.toLowerCase().includes(query.toLowerCase()) ||
      cmd.description?.toLowerCase().includes(query.toLowerCase())
  );
  const activeCommand = filteredCommands[selectedIndex];
  const activeOptionId = activeCommand ? `command-palette-option-${activeCommand.id}` : undefined;

  // useWindowEvent automatically manages event listeners
  useWindowEvent('keydown', (e: KeyboardEvent) => {
    if (!isOpen) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex((prev) =>
          filteredCommands.length > 0 ? (prev + 1) % filteredCommands.length : 0
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((prev) =>
          filteredCommands.length > 0
            ? (prev - 1 + filteredCommands.length) % filteredCommands.length
            : 0
        );
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
      previouslyFocusedRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setQuery('');
      setSelectedIndex(0);
      inputRef.current?.focus();

      return () => {
        previouslyFocusedRef.current?.focus();
        previouslyFocusedRef.current = null;
      };
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
          role="dialog"
          aria-modal="true"
          aria-label="Command Palette"
        >
          <div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--color-border)]">
            <Search
              size={20}
              className="flex-shrink-0 text-[var(--color-text-secondary)]"
              aria-hidden="true"
            />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-label="Command search"
              aria-controls="command-palette-listbox"
              aria-expanded={filteredCommands.length > 0}
              aria-activedescendant={activeOptionId}
              aria-autocomplete="list"
              placeholder={t('commandPalette.placeholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="flex-1 bg-transparent text-base text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)] focus-visible:ring-0"
            />
            <kbd className="px-2 py-1 text-xs rounded text-[var(--color-text-secondary)] bg-[var(--color-bg-tertiary)]">
              Esc
            </kbd>
          </div>

          <div
            id="command-palette-listbox"
            role="listbox"
            aria-label="Commands"
            className="max-h-[50vh] overflow-y-auto py-2"
          >
            {filteredCommands.length === 0 ? (
              <div className="px-5 py-8 text-center text-[var(--color-text-secondary)]">
                {t('commandPalette.noResults')}
              </div>
            ) : (
              filteredCommands.map((cmd, index) => (
                <button
                  key={cmd.id}
                  id={`command-palette-option-${cmd.id}`}
                  type="button"
                  role="option"
                  aria-selected={index === selectedIndex}
                  onClick={cmd.action}
                  onMouseEnter={() => setSelectedIndex(index)}
                  className={`flex w-full cursor-pointer items-center gap-4 px-5 py-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
                    index === selectedIndex ? 'bg-[var(--color-bg-tertiary)]' : ''
                  }`}
                >
                  <div
                    className={`flex-shrink-0 ${
                      cmd.category === 'ai'
                        ? 'text-[var(--color-info)]'
                        : 'text-[var(--color-text-secondary)]'
                    }`}
                    aria-hidden="true"
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
                <kbd className="px-1.5 py-0.5 rounded mr-1 bg-[var(--color-bg-tertiary)]">
                  Arrow keys
                </kbd>
                {t('commandPalette.navigate')}
              </span>
              <span>
                <kbd className="px-1.5 py-0.5 rounded mr-1 bg-[var(--color-bg-tertiary)]">
                  Enter
                </kbd>
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
