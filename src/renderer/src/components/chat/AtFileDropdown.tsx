/**
 * @file AtFileDropdown — file picker overlay shown while the user is
 *   typing an `@` mention in chat input. Pure presentation: no
 *   knowledge of textareas or trigger detection. Caller provides the
 *   candidate list (already filtered + ranked) plus the selected index
 *   for keyboard navigation; dropdown emits onSelect / onCancel.
 *
 * Why caller owns the selected index: keyboard nav (Up/Down/Enter) is
 * caught by the parent textarea's onKeyDown so the input doesn't lose
 * focus. Keeping selection state out of this component avoids the
 * "two sources of truth" tangle that comes from a self-contained
 * dropdown.
 */

import type React from 'react';
import { useEffect, useRef } from 'react';
import { useTranslation } from '../../locales';

interface AtFileDropdownProps {
  id?: string;
  label?: string;
  optionIdPrefix?: string;
  activeId?: string;
  items: string[];
  selectedIndex: number;
  onSelect: (path: string) => void;
  onCancel: () => void;
}

export const AtFileDropdown: React.FC<AtFileDropdownProps> = ({
  id,
  label,
  optionIdPrefix,
  activeId,
  items,
  selectedIndex,
  onSelect,
  onCancel,
}) => {
  const { t } = useTranslation();
  const listRef = useRef<HTMLUListElement | null>(null);

  // Auto-scroll active item into view as selection moves.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (items.length === 0) {
    return (
      <div
        className="absolute bottom-full left-0 right-0 mb-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2 text-[11px] text-[var(--color-text-muted)] shadow-md"
        onClick={onCancel}
      >
        {t('atFileDropdown.noMatch')}
      </div>
    );
  }

  return (
    <ul
      id={id}
      ref={listRef}
      className="absolute bottom-full left-0 right-0 mb-1 max-h-64 overflow-y-auto rounded border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-md"
      role="listbox"
      aria-label={label ?? t('atFileDropdown.label')}
    >
      {items.map((path, idx) => {
        const sepIdx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
        const dir = sepIdx >= 0 ? path.slice(0, sepIdx + 1) : '';
        const name = sepIdx >= 0 ? path.slice(sepIdx + 1) : path;
        const active = idx === selectedIndex;
        const optionId = optionIdPrefix
          ? `${optionIdPrefix}-${idx}`
          : active
            ? activeId
            : undefined;
        return (
          <li
            id={optionId}
            key={path}
            role="option"
            aria-selected={active}
            // Use mousedown not click so focus doesn't slip back to the
            // textarea (which would cancel the trigger before onSelect
            // fires). preventDefault keeps the textarea active.
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(path);
            }}
            className={`cursor-pointer px-3 py-1.5 text-[12px] ${
              active
                ? 'bg-[var(--color-accent)] text-white'
                : 'text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]'
            }`}
          >
            <span className="font-medium">{name}</span>
            {dir && (
              <span
                className={`ml-2 text-[11px] ${
                  active ? 'text-white/70' : 'text-[var(--color-text-muted)]'
                }`}
              >
                {dir}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
};

/**
 * Pure scorer kept beside the dropdown so callers can reuse the same
 * ranking. Substring on basename outranks substring on directory part;
 * exact basename match wins outright. Returns -1 for "no match".
 */
export function scoreFilePath(path: string, query: string): number {
  if (!query) return 0;
  const lcPath = path.toLowerCase();
  const lcQuery = query.toLowerCase();
  const sepIdx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const name = sepIdx >= 0 ? lcPath.slice(sepIdx + 1) : lcPath;
  if (name === lcQuery) return 1000;
  const nameIdx = name.indexOf(lcQuery);
  if (nameIdx >= 0) return 500 - nameIdx;
  const pathIdx = lcPath.indexOf(lcQuery);
  if (pathIdx >= 0) return 100 - pathIdx;
  return -1;
}
