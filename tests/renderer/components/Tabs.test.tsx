import { fireEvent, render, screen } from '@testing-library/react';
import { Search } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../../../src/renderer/src/components/ui/Tabs';

describe('Tabs', () => {
  it('exposes tabs, panels, and decorative trigger icons with keyboard-visible state', () => {
    const onChange = vi.fn();

    render(
      <Tabs defaultValue="files" onChange={onChange}>
        <TabsList aria-label="Workspace panels">
          <TabsTrigger value="files" icon={<Search data-testid="files-icon" />}>
            Files
          </TabsTrigger>
          <TabsTrigger value="chat">Chat</TabsTrigger>
        </TabsList>
        <TabsContent value="files">Files panel</TabsContent>
        <TabsContent value="chat">Chat panel</TabsContent>
      </Tabs>
    );

    const files = screen.getByRole('tab', { name: 'Files' });
    expect(files).toHaveAttribute('aria-selected', 'true');
    expect(files).toHaveClass('cursor-pointer');
    expect(files).toHaveClass('focus-visible:ring-2');
    expect(screen.getByTestId('files-icon')).toHaveAttribute('aria-hidden', 'true');

    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', files.id);

    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    expect(onChange).toHaveBeenCalledWith('chat');
  });
});
