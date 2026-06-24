import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AtCiteDropdown } from '../../../src/renderer/src/components/chat/AtCiteDropdown';
import { AtFileDropdown } from '../../../src/renderer/src/components/chat/AtFileDropdown';

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'atFileDropdown.label': 'File suggestions',
        'atFileDropdown.noMatch': 'No matching files',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('AtFileDropdown', () => {
  it('names the file suggestions listbox and exposes a stable active option id', () => {
    const onSelect = vi.fn();

    render(
      <AtFileDropdown
        id="chat-file-suggestions"
        activeId="chat-file-suggestion-1"
        items={['paper.tex', 'sections/intro.tex']}
        selectedIndex={1}
        onSelect={onSelect}
        onCancel={vi.fn()}
      />
    );

    const listbox = screen.getByRole('listbox', { name: 'File suggestions' });
    expect(listbox).toHaveAttribute('id', 'chat-file-suggestions');

    const active = screen.getByRole('option', { name: /intro\.tex/ });
    expect(active).toHaveAttribute('id', 'chat-file-suggestion-1');
    expect(active).toHaveAttribute('aria-selected', 'true');

    fireEvent.mouseDown(active);
    expect(onSelect).toHaveBeenCalledWith('sections/intro.tex');
  });
});

describe('AtCiteDropdown', () => {
  it('names citation suggestions and exposes a stable active option id', () => {
    const onSelect = vi.fn();
    const hit = {
      score: 10,
      item: {
        itemKey: 'z-1',
        citationKey: 'doe2024',
        title: 'Accessible Scientific Writing',
        creatorsLabel: 'Doe',
        year: 2024,
      },
    };

    render(
      <AtCiteDropdown
        id="chat-cite-suggestions"
        label="Citation suggestions"
        activeId="chat-cite-suggestion-0"
        items={[hit]}
        selectedIndex={0}
        onSelect={onSelect}
        emptyText="No citations"
      />
    );

    const listbox = screen.getByRole('listbox', { name: 'Citation suggestions' });
    expect(listbox).toHaveAttribute('id', 'chat-cite-suggestions');

    const active = screen.getByRole('option', { name: /doe2024/ });
    expect(active).toHaveAttribute('id', 'chat-cite-suggestion-0');
    expect(active).toHaveAttribute('aria-selected', 'true');

    fireEvent.mouseDown(active);
    expect(onSelect).toHaveBeenCalledWith(hit);
  });
});
