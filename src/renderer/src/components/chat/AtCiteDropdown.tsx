/**
 * @file AtCiteDropdown — citation picker shown when the user types
 *   `@cite:` inside a chat input. Mirrors `AtFileDropdown`'s ergonomics
 *   (caller owns selected index; preventDefault on mousedown keeps the
 *   textarea focused) but renders a richer two-line layout because
 *   citation keys without title are unreadable.
 *
 * Empty / loading / wizard-needed states are not handled here — the
 * parent wires those to `useZoteroWizard.open()` so the dropdown stays
 * a pure presentation component.
 */

import type React from 'react';
import { useEffect, useRef } from 'react';
import type { BibSearchHit } from '../../services/zotero/bibSearchScoring';

interface AtCiteDropdownProps {
  id?: string;
  label?: string;
  optionIdPrefix?: string;
  activeId?: string;
  items: BibSearchHit[];
  selectedIndex: number;
  onSelect: (hit: BibSearchHit) => void;
  emptyText: string;
}

export const AtCiteDropdown: React.FC<AtCiteDropdownProps> = ({
  id,
  label,
  optionIdPrefix,
  activeId,
  items,
  selectedIndex,
  onSelect,
  emptyText,
}) => {
  const listRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (items.length === 0) {
    return (
      <div className="absolute bottom-full left-0 right-0 mb-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2 text-[11px] text-[var(--color-text-muted)] shadow-md">
        {emptyText}
      </div>
    );
  }

  return (
    <ul
      id={id}
      ref={listRef}
      className="absolute bottom-full left-0 right-0 mb-1 max-h-64 overflow-y-auto rounded border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-md"
      role="listbox"
      aria-label={label}
    >
      {items.map((hit, idx) => {
        const active = idx === selectedIndex;
        const item = hit.item;
        const keyLabel = item.citationKey ?? item.itemKey;
        const optionId = optionIdPrefix
          ? `${optionIdPrefix}-${idx}`
          : active
            ? activeId
            : undefined;
        const meta = [item.creatorsLabel, item.year].filter(Boolean).join(' · ');
        return (
          <li
            id={optionId}
            key={item.itemKey}
            role="option"
            aria-selected={active}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(hit);
            }}
            className={`cursor-pointer px-3 py-1.5 ${
              active
                ? 'bg-[var(--color-accent)] text-white'
                : 'text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]'
            }`}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-[12px] font-medium">{keyLabel}</span>
              {meta && (
                <span
                  className={`text-[11px] ${
                    active ? 'text-white/70' : 'text-[var(--color-text-muted)]'
                  }`}
                >
                  {meta}
                </span>
              )}
            </div>
            {item.title && (
              <div
                className={`mt-0.5 truncate text-[11px] ${
                  active ? 'text-white/85' : 'text-[var(--color-text-secondary)]'
                }`}
                title={item.title}
              >
                {item.title}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
};
