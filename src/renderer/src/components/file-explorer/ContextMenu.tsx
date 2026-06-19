/**
 * @file ContextMenu.tsx - File Explorer context menu component
 * @description Right-click context menu with file/folder operations (create, rename, copy, cut, paste, delete).
 */

import { clsx } from 'clsx';
import { motion } from 'framer-motion';
import {
  Clipboard,
  Copy,
  Edit3,
  ExternalLink,
  FolderPlus,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type React from 'react';
import { memo, useCallback, useEffect, useRef } from 'react';
import { useClickOutside, useEscapeKey } from '../../hooks';
import { useTranslation } from '../../locales';
import { getClipboardItem } from './clipboard';

export interface ContextMenuProps {
  x: number;
  y: number;
  node: import('../../types').FileNode | null;
  isRoot: boolean;
  isRemote: boolean;
  onClose: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onRename: () => void;
  onDelete: () => void;
  onCopy: () => void;
  onCut: () => void;
  onPaste: () => void;
  onOpenInExplorer: () => void;
  onRefresh: () => void;
}

export const ContextMenu = memo<ContextMenuProps>(
  ({
    x,
    y,
    isRoot,
    isRemote,
    onClose,
    onNewFile,
    onNewFolder,
    onRename,
    onDelete,
    onCopy,
    onCut,
    onPaste,
    onOpenInExplorer,
    onRefresh,
  }) => {
    const menuRef = useRef<HTMLDivElement>(null);
    const previouslyFocusedRef = useRef<HTMLElement | null>(null);
    const { t } = useTranslation();

    useClickOutside(menuRef, onClose);
    useEscapeKey(onClose);

    const getEnabledMenuItems = useCallback(
      () =>
        Array.from(
          menuRef.current?.querySelectorAll<HTMLButtonElement>(
            '[role="menuitem"]:not(:disabled)'
          ) ?? []
        ),
      []
    );

    useEffect(() => {
      previouslyFocusedRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      getEnabledMenuItems()[0]?.focus();

      return () => {
        previouslyFocusedRef.current?.focus();
        previouslyFocusedRef.current = null;
      };
    }, [getEnabledMenuItems]);

    const focusMenuItem = useCallback(
      (direction: 1 | -1) => {
        const items = getEnabledMenuItems();
        if (items.length === 0) return;

        const currentIndex = items.findIndex((item) => item === document.activeElement);
        const nextIndex =
          currentIndex === -1 ? 0 : (currentIndex + direction + items.length) % items.length;
        items[nextIndex]?.focus();
      },
      [getEnabledMenuItems]
    );

    const handleKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLDivElement>) => {
        switch (event.key) {
          case 'ArrowDown':
            event.preventDefault();
            focusMenuItem(1);
            break;
          case 'ArrowUp':
            event.preventDefault();
            focusMenuItem(-1);
            break;
          case 'Home':
            event.preventDefault();
            getEnabledMenuItems()[0]?.focus();
            break;
          case 'End': {
            event.preventDefault();
            const items = getEnabledMenuItems();
            items[items.length - 1]?.focus();
            break;
          }
          case 'Enter':
          case ' ':
            if (document.activeElement instanceof HTMLButtonElement) {
              event.preventDefault();
              document.activeElement.click();
            }
            break;
          case 'Escape':
            event.preventDefault();
            onClose();
            break;
        }
      },
      [focusMenuItem, getEnabledMenuItems, onClose]
    );

    // Clamp position to keep the menu inside the viewport.
    const adjustedY = Math.min(y, window.innerHeight - 300);
    const adjustedX = Math.min(x, window.innerWidth - 200);

    const MenuItem: React.FC<{
      icon: React.ReactNode;
      label: string;
      onClick: () => void;
      danger?: boolean;
      disabled?: boolean;
    }> = ({ icon, label, onClick, danger, disabled }) => (
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          if (disabled) return;
          onClick();
          onClose();
        }}
        disabled={disabled}
        aria-disabled={disabled ? 'true' : undefined}
        className={clsx(
          'w-full flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[13px] transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-inset',
          disabled && 'opacity-30 disabled:cursor-not-allowed'
        )}
        style={{
          color: danger ? 'var(--color-error)' : 'var(--color-text-primary)',
          background: 'transparent',
        }}
        onMouseEnter={(e) => {
          if (disabled) return;
          e.currentTarget.style.background = danger
            ? 'var(--color-error-muted)'
            : 'var(--color-bg-hover)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
        }}
      >
        <span
          aria-hidden="true"
          style={{ color: danger ? 'var(--color-error)' : 'var(--color-text-muted)', opacity: 0.7 }}
        >
          {icon}
        </span>
        <span className="flex-1 text-left">{label}</span>
      </button>
    );

    const Divider = () => (
      <div className="h-px my-1 mx-1" style={{ background: 'var(--color-border-subtle)' }} />
    );

    return (
      <motion.div
        ref={menuRef}
        role="menu"
        aria-label={t('fileExplorerMenu.actions')}
        onKeyDown={handleKeyDown}
        initial={{ opacity: 0, scale: 0.98, y: -5 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, y: -5 }}
        transition={{ duration: 0.15, type: 'spring', stiffness: 400, damping: 30 }}
        className="fixed z-[100] backdrop-blur-md rounded-xl shadow-2xl py-1.5 min-w-[200px] overflow-hidden"
        style={{
          left: adjustedX,
          top: adjustedY,
          background: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-border)',
        }}
      >
        <MenuItem
          icon={<Plus size={14} />}
          label={t('fileExplorerMenu.newFile')}
          onClick={onNewFile}
        />
        <MenuItem
          icon={<FolderPlus size={14} />}
          label={t('fileExplorerMenu.newFolder')}
          onClick={onNewFolder}
        />
        <Divider />
        {!isRoot && (
          <>
            <MenuItem
              icon={<Edit3 size={14} />}
              label={t('fileExplorerMenu.rename')}
              onClick={onRename}
            />
            <MenuItem
              icon={<Copy size={14} />}
              label={t('fileExplorerMenu.copy')}
              onClick={onCopy}
            />
            <MenuItem icon={<Copy size={14} />} label={t('fileExplorerMenu.cut')} onClick={onCut} />
          </>
        )}
        <MenuItem
          icon={<Clipboard size={14} />}
          label={t('fileExplorerMenu.paste')}
          onClick={onPaste}
          disabled={!getClipboardItem()}
        />
        {!isRoot && (
          <>
            <Divider />
            <MenuItem
              icon={<Trash2 size={14} />}
              label={t('fileExplorerMenu.delete')}
              onClick={onDelete}
              danger
            />
          </>
        )}
        <Divider />
        {!isRemote && (
          <MenuItem
            icon={<ExternalLink size={14} />}
            label={t('fileExplorerMenu.openInExplorer')}
            onClick={onOpenInExplorer}
          />
        )}
        <MenuItem
          icon={<RefreshCw size={14} />}
          label={t('fileExplorerMenu.refresh')}
          onClick={onRefresh}
        />
      </motion.div>
    );
  }
);
ContextMenu.displayName = 'ContextMenu';
