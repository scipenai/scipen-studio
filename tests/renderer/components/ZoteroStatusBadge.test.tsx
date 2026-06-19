import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ZoteroStatusBadge } from '../../../src/renderer/src/components/layout/ZoteroStatusBadge';
import type { ZoteroBibMirrorState } from '../../../src/renderer/src/services/zotero/ZoteroBibMirror';

const mockZotero = vi.hoisted(() => ({
  fetchDiagnostics: vi.fn(() => new Promise(() => undefined)),
  refresh: vi.fn().mockResolvedValue({ triggered: true, status: 'ready' }),
  state: {
    status: 'ready',
    etag: 'etag-1',
    itemCount: 42,
    lastSyncedAt: '2026-06-16T10:00:00.000Z',
  } as ZoteroBibMirrorState,
}));

vi.mock('../../../src/renderer/src/hooks', () => ({
  useClickOutside: () => undefined,
}));

vi.mock('../../../src/renderer/src/hooks/useZoteroBibMirror', () => ({
  useZoteroBibMirror: () => ({
    enabled: true,
    state: mockZotero.state,
    mirror: {
      fetchDiagnostics: mockZotero.fetchDiagnostics,
      refresh: mockZotero.refresh,
    },
  }),
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'zotero.status.tooltipPrefix': 'Zotero index',
        'zotero.status.ready': 'Ready',
        'zotero.status.label': 'Zotero',
        'zotero.diagnostics.title': 'Zotero index diagnostics',
        'zotero.diagnostics.status': 'Status',
        'zotero.diagnostics.itemCount': 'Items',
        'zotero.diagnostics.lastSyncedAt': 'Last synced',
        'zotero.diagnostics.never': 'Never',
        'zotero.diagnostics.localApi': 'Local API',
        'zotero.diagnostics.betterBibTex': 'Better BibTeX',
        'zotero.diagnostics.close': 'Close',
        'zotero.diagnostics.refresh': 'Refresh now',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('ZoteroStatusBadge', () => {
  it('exposes the Zotero status badge as an expandable diagnostics control', () => {
    render(<ZoteroStatusBadge />);

    const trigger = screen.getByRole('button', { name: 'Zotero index: Ready' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger).toHaveClass('focus-visible:ring-1');

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const popover = screen.getByRole('dialog', { name: 'Zotero index diagnostics' });
    expect(trigger).toHaveAttribute('aria-controls', popover.id);
  });

  it('renders diagnostics actions with pointer and keyboard focus feedback', () => {
    render(<ZoteroStatusBadge />);

    fireEvent.click(screen.getByRole('button', { name: 'Zotero index: Ready' }));

    const close = screen.getByRole('button', { name: 'Close' });
    expect(close).toHaveClass('cursor-pointer');
    expect(close).toHaveClass('focus-visible:ring-1');

    const refresh = screen.getByRole('button', { name: 'Refresh now' });
    expect(refresh).toHaveClass('cursor-pointer');
    expect(refresh).toHaveClass('focus-visible:ring-1');
  });

  it('moves focus into diagnostics and restores it when Escape closes the popover', () => {
    render(<ZoteroStatusBadge />);

    const trigger = screen.getByRole('button', { name: 'Zotero index: Ready' });
    trigger.focus();
    fireEvent.click(trigger);

    const close = screen.getByRole('button', { name: 'Close' });
    expect(close).toHaveFocus();

    fireEvent.keyDown(close, { key: 'Escape' });
    expect(
      screen.queryByRole('dialog', { name: 'Zotero index diagnostics' })
    ).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('keeps tab focus cycling inside diagnostics actions', () => {
    render(<ZoteroStatusBadge />);

    fireEvent.click(screen.getByRole('button', { name: 'Zotero index: Ready' }));

    const close = screen.getByRole('button', { name: 'Close' });
    const refresh = screen.getByRole('button', { name: 'Refresh now' });
    expect(close).toHaveFocus();

    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(refresh).toHaveFocus();

    fireEvent.keyDown(refresh, { key: 'Tab' });
    expect(close).toHaveFocus();
  });
});
