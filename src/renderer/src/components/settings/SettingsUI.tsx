/**
 * @file SettingsUI.tsx - Settings Panel UI Component
 * @description Shared UI components for the settings panel, including titles, setting items, toggles, etc.
 */

import React from 'react';
import { Toggle as UIToggle } from '../ui';

/**
 * Settings section title
 */
export const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h3 className="text-xs font-semibold uppercase tracking-wider mt-6 mb-3 first:mt-0 text-[var(--color-text-muted)]">
    {children}
  </h3>
);

/**
 * Setting item container
 */
export const SettingItem: React.FC<{
  label: string;
  description?: string;
  children: React.ReactNode;
  inline?: boolean;
}> = ({ label, description, children, inline }) => (
  <div className={`mb-4 ${inline ? 'flex items-center justify-between gap-4' : ''}`}>
    <div className={inline ? 'flex-1' : ''}>
      <label className="block text-sm font-medium mb-1 text-[var(--color-text-secondary)]">
        {label}
      </label>
      {description && (
        <p className="text-xs text-[var(--color-text-muted)] mb-1.5">{description}</p>
      )}
    </div>
    {inline ? <div className="flex-shrink-0">{children}</div> : children}
  </div>
);

/**
 * Toggle setting item (uses new component library)
 */
export const Toggle: React.FC<{
  label: string;
  desc?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}> = ({ label, desc, checked, onChange, disabled }) => (
  <UIToggle
    label={label}
    description={desc}
    checked={checked}
    onChange={onChange}
    disabled={disabled}
    labelPosition="left"
    className="py-2"
  />
);

/**
 * Shortcut display (read-only)
 */
export const Shortcut: React.FC<{ label: string; keys: string }> = ({ label, keys }) => (
  <div className="flex items-center justify-between py-2 border-b border-[var(--color-border-subtle)]">
    <span className="text-sm text-[var(--color-text-primary)]">{label}</span>
    <kbd className="px-2 py-0.5 rounded text-xs font-mono bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">
      {keys}
    </kbd>
  </div>
);

/**
 * Editable shortcut
 * Click to enter recording mode, press key combination to set
 */
export const EditableShortcut: React.FC<{
  label: string;
  keys: string;
  onChange: (newKeys: string) => void;
}> = ({ label, keys, onChange }) => {
  const [isRecording, setIsRecording] = React.useState(false);
  const [tempKeys, setTempKeys] = React.useState('');

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isRecording) return;

    e.preventDefault();
    e.stopPropagation();

    // Ignore modifier keys alone
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
      return;
    }

    // Build shortcut string
    const parts: string[] = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.shiftKey) parts.push('Shift');
    if (e.altKey) parts.push('Alt');

    // Handle special key names
    let keyName = e.key;
    if (keyName === ' ') keyName = 'Space';
    else if (keyName === 'ArrowUp') keyName = 'Up';
    else if (keyName === 'ArrowDown') keyName = 'Down';
    else if (keyName === 'ArrowLeft') keyName = 'Left';
    else if (keyName === 'ArrowRight') keyName = 'Right';
    else if (keyName.length === 1) keyName = keyName.toUpperCase();

    parts.push(keyName);

    const newShortcut = parts.join('+');
    setTempKeys(newShortcut);
    onChange(newShortcut);
    setIsRecording(false);
  };

  const handleClick = () => {
    setIsRecording(true);
    setTempKeys('');
  };

  const handleBlur = () => {
    setIsRecording(false);
    setTempKeys('');
  };

  return (
    <div className="flex items-center justify-between py-2 border-b border-[var(--color-border-subtle)]">
      <span className="text-sm text-[var(--color-text-primary)]">{label}</span>
      <button
        type="button"
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        className={`px-3 py-1 rounded text-xs font-mono transition-colors min-w-[100px] text-center ${
          isRecording
            ? 'bg-[var(--color-accent)] text-white animate-pulse'
            : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]'
        }`}
      >
        {isRecording ? tempKeys || 'Press shortcut...' : keys}
      </button>
    </div>
  );
};

/**
 * Settings card
 */
export const SettingCard: React.FC<{
  title?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}> = ({ title, description, children, className }) => (
  <div
    className={`p-4 rounded-xl bg-[var(--color-bg-elevated)] border border-[var(--color-border)] ${className || ''}`}
  >
    {title && (
      <h4 className="text-sm font-medium text-[var(--color-text-primary)] mb-1">{title}</h4>
    )}
    {description && <p className="text-xs text-[var(--color-text-muted)] mb-3">{description}</p>}
    {children}
  </div>
);

/**
 * Input field style class (for className)
 */
export const inputClassName = `
  w-full h-9 px-3 py-2 rounded-lg text-sm
  bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]
  text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)]
  focus:border-[var(--color-accent)] focus:shadow-[0_0_0_3px_var(--color-accent-muted)] focus:outline-none
  disabled:cursor-not-allowed disabled:opacity-50
  transition-colors duration-200
`;

/**
 * Select field style class (for className)
 */
export const selectClassName = `
  w-full h-9 px-3 py-2 rounded-lg text-sm
  bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]
  text-[var(--color-text-primary)]
  focus:border-[var(--color-accent)] focus:shadow-[0_0_0_3px_var(--color-accent-muted)] focus:outline-none
  disabled:cursor-not-allowed disabled:opacity-50
  transition-colors duration-200 cursor-pointer
`;
