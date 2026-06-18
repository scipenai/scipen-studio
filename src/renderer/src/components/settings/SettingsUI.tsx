/**
 * @file SettingsUI.tsx - Settings Panel UI Component
 * @description Shared UI components for the settings panel, including titles, setting items, toggles, etc.
 */

import React, { cloneElement, isValidElement, useId } from 'react';
import { Toggle as UIToggle } from '../ui';

type NativeFieldElement =
  React.ReactElement<
    React.HTMLAttributes<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement> & {
      id?: string;
    },
    'input' | 'select' | 'textarea'
  >;

function isNativeFieldElement(child: React.ReactNode): child is NativeFieldElement {
  return isValidElement(child) && ['input', 'select', 'textarea'].includes(String(child.type));
}

function hasNativeField(children: React.ReactNode): boolean {
  let hasField = false;
  React.Children.forEach(children, (child) => {
    if (!hasField && isNativeFieldElement(child)) {
      hasField = true;
    }
  });

  return hasField;
}

function connectNativeField(
  children: React.ReactNode,
  fieldId: string,
  descriptionId?: string
): React.ReactNode {
  if (!hasNativeField(children)) {
    return children;
  }

  let connected = false;
  return React.Children.map(children, (child) => {
    if (connected || !isNativeFieldElement(child)) {
      return child;
    }

    connected = true;
    const existingDescribedBy = child.props['aria-describedby'];
    return cloneElement(child, {
      id: child.props.id ?? fieldId,
      'aria-describedby':
        [existingDescribedBy, descriptionId].filter(Boolean).join(' ') || undefined,
    });
  });
}

function getNativeFieldId(children: React.ReactNode): string | undefined {
  let fieldId: string | undefined;
  React.Children.forEach(children, (child) => {
    if (!fieldId && isNativeFieldElement(child)) {
      fieldId = child.props.id;
    }
  });

  return fieldId;
}

/**
 * Settings section title
 */
export const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h3 className="mt-8 mb-4 border-b border-[var(--color-border-subtle)] pb-2 text-sm font-semibold text-[var(--color-text-primary)] first:mt-0">
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
}> = ({ label, description, children, inline }) => {
  const generatedId = useId();
  const fieldId = getNativeFieldId(children) ?? `setting-${generatedId.replace(/:/g, '')}`;
  const descriptionId = description ? `${fieldId}-description` : undefined;
  const connectedChildren = connectNativeField(children, fieldId, descriptionId);

  return (
    <div className={`mb-4 ${inline ? 'flex items-center justify-between gap-4' : ''}`}>
      <div className={inline ? 'flex-1' : ''}>
        <label
          htmlFor={fieldId}
          className="block text-sm font-medium mb-1 text-[var(--color-text-secondary)]"
        >
          {label}
        </label>
        {description && (
          <p id={descriptionId} className="text-xs text-[var(--color-text-muted)] mb-1.5">
            {description}
          </p>
        )}
      </div>
      {inline ? <div className="flex-shrink-0">{connectedChildren}</div> : connectedChildren}
    </div>
  );
};

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

  const displayKeys = isRecording ? tempKeys || 'Press shortcut...' : keys;

  return (
    <div className="flex items-center justify-between py-2 border-b border-[var(--color-border-subtle)]">
      <span className="text-sm text-[var(--color-text-primary)]">{label}</span>
      <button
        type="button"
        aria-label={`${label} ${displayKeys}`}
        aria-pressed={isRecording}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        className={`min-w-[100px] cursor-pointer rounded px-3 py-1 text-center text-xs font-mono transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
          isRecording
            ? 'bg-[var(--color-accent)] text-white animate-pulse'
            : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]'
        }`}
      >
        {displayKeys}
      </button>
    </div>
  );
};

/**
 * Settings card
 */
export const SettingCard: React.FC<{
  title?: string;
  description?: React.ReactNode;
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
 * Monospace input variant — for identifiers the user reads/compares
 * char-by-char (API keys, base URLs, model IDs, file paths, shell
 * commands). Tabular glyphs make typos and trailing spaces visible.
 */
export const inputMonoClassName = `${inputClassName} font-mono`;

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

// ============================================================================
// Modern form design system — used by the refactored settings pages
// (AI service / Agent behavior / Zotero). Structure and spacing follow the
// unified spec; colors map exclusively to --color-* tokens so light/dark
// themes work uniformly (never hardcode slate/white — the default dark
// theme would break).
// ============================================================================

/** Section title with a thin bottom divider. Pass `first` on the first
 *  section to remove the top margin. */
export const FormSection: React.FC<{
  title: string;
  first?: boolean;
  children: React.ReactNode;
}> = ({ title, first, children }) => (
  <section className={first ? '' : 'mt-8'}>
    <h3 className="mb-4 border-b border-[var(--color-border-subtle)] pb-2 text-sm font-semibold text-[var(--color-text-primary)]">
      {title}
    </h3>
    {children}
  </section>
);

/** Horizontal row: title/description on the left, control (Toggle /
 *  button / short dropdown) on the right. */
export const FormRow: React.FC<{
  title: string;
  description?: string;
  children: React.ReactNode;
}> = ({ title, description, children }) => (
  <div className="flex items-center justify-between py-3">
    <div className="flex flex-col pr-4">
      <span className="text-sm font-medium text-[var(--color-text-primary)]">{title}</span>
      {description && (
        <span className="mt-1 text-xs text-[var(--color-text-muted)]">{description}</span>
      )}
    </div>
    <div className="flex-shrink-0">{children}</div>
  </div>
);

/** Stacked row: long inputs (API Key / URL / model ID) with the title and
 *  description on top and the input below. */
export const FormField: React.FC<{
  title: string;
  description?: string;
  children: React.ReactNode;
}> = ({ title, description, children }) => {
  const generatedId = useId();
  const fieldId = getNativeFieldId(children) ?? `form-field-${generatedId.replace(/:/g, '')}`;
  const descriptionId = description ? `${fieldId}-description` : undefined;
  const connectedChildren = connectNativeField(children, fieldId, descriptionId);

  return (
    <div className="flex flex-col py-3">
      <label htmlFor={fieldId} className="text-sm font-medium text-[var(--color-text-primary)]">
        {title}
      </label>
      {description && (
        <span id={descriptionId} className="mb-2 mt-1 text-xs text-[var(--color-text-muted)]">
          {description}
        </span>
      )}
      {connectedChildren}
    </div>
  );
};

/** Dashed empty-state box (e.g. when no MCP server is configured). */
export const EmptyState: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className,
}) => (
  <div
    className={`mt-2 rounded-lg border-2 border-dashed border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 text-center text-sm text-[var(--color-text-muted)] ${className || ''}`}
  >
    {children}
  </div>
);

/** Secondary button (light-fill, outlined, soft shadow — fully tokenized). */
export const secondaryButtonClass =
  'inline-flex items-center justify-center gap-1.5 rounded-md border ' +
  'border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-sm)] ' +
  'px-3 py-1.5 text-sm font-medium text-[var(--color-text-primary)] ' +
  'cursor-pointer hover:bg-[var(--color-bg-hover)] focus:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50 ' +
  'transition-colors';
