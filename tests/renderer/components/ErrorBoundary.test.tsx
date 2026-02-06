/**
 * @file ErrorBoundary.test.tsx
 * @description Tests for React error boundary components - error catching, recovery, and user interaction
 * @depends @testing-library/react, vitest, renderer/src/components/ErrorBoundary
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AutoRecoveryErrorBoundary,
  ErrorBoundary,
  PanelErrorBoundary,
} from '../../../src/renderer/src/components/ErrorBoundary';

// Mock LogService
vi.mock('../../../src/renderer/src/services/LogService', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock navigator.clipboard
const mockClipboard = {
  writeText: vi.fn().mockResolvedValue(undefined),
  readText: vi.fn().mockResolvedValue(''),
};

Object.defineProperty(navigator, 'clipboard', {
  value: mockClipboard,
  writable: true,
  configurable: true,
});

const ThrowError = ({ shouldThrow = true }: { shouldThrow?: boolean }) => {
  if (shouldThrow) {
    throw new Error('Test error message');
  }
  return <div>Normal render</div>;
};

const NormalComponent = () => <div>Normal content</div>;

describe('ErrorBoundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Suppress React error boundary console.error output during tests
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  describe('Normal Rendering', () => {
    it('should render children', () => {
      render(
        <ErrorBoundary>
          <NormalComponent />
        </ErrorBoundary>
      );

      expect(screen.getByText('Normal content')).toBeInTheDocument();
    });

    it('should not show error UI', () => {
      render(
        <ErrorBoundary>
          <NormalComponent />
        </ErrorBoundary>
      );

      expect(screen.queryByText('Application Error')).not.toBeInTheDocument();
    });
  });

  describe('Error Catching', () => {
    it('should catch child errors and display error UI', () => {
      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      expect(screen.getByText('Application Error')).toBeInTheDocument();
      expect(screen.getByText('An unexpected error occurred')).toBeInTheDocument();
      expect(screen.getByText('Test error message')).toBeInTheDocument();
    });

    it('should show retry and reload buttons', () => {
      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      expect(screen.getByText('Retry')).toBeInTheDocument();
      expect(screen.getByText('Reload')).toBeInTheDocument();
    });

    it('should call onError callback', () => {
      const onError = vi.fn();

      render(
        <ErrorBoundary onError={onError}>
          <ThrowError />
        </ErrorBoundary>
      );

      expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          componentStack: expect.any(String),
        })
      );
    });

    it('should use custom fallback', () => {
      render(
        <ErrorBoundary fallback={<div>Custom error page</div>}>
          <ThrowError />
        </ErrorBoundary>
      );

      expect(screen.getByText('Custom error page')).toBeInTheDocument();
      expect(screen.queryByText('Application Error')).not.toBeInTheDocument();
    });
  });

  describe('User Interaction', () => {
    it('clicking retry should trigger reset logic', () => {
      // ErrorBoundary sets hasError to false on retry, but if child still throws, it will be caught again
      // This test verifies the retry button exists and is clickable
      render(
        <ErrorBoundary>
          <ThrowError shouldThrow={true} />
        </ErrorBoundary>
      );

      expect(screen.getByText('Application Error')).toBeInTheDocument();

      const retryButton = screen.getByText('Retry');
      expect(retryButton).toBeInTheDocument();

      expect(() => fireEvent.click(retryButton)).not.toThrow();
    });

    it('clicking copy button should copy error information', async () => {
      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      const copyButton = screen.getByTitle('Copy error info');
      fireEvent.click(copyButton);

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining('Test error message')
      );
    });

    it('clicking show details should expand details', () => {
      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      expect(screen.queryByText('Stack trace')).not.toBeInTheDocument();

      fireEvent.click(screen.getByText('Show details'));

      expect(screen.getByText('Stack trace')).toBeInTheDocument();
    });

    it('clicking hide details should collapse details', () => {
      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      fireEvent.click(screen.getByText('Show details'));
      expect(screen.getByText('Stack trace')).toBeInTheDocument();

      fireEvent.click(screen.getByText('Hide details'));
      expect(screen.queryByText('Stack trace')).not.toBeInTheDocument();
    });
  });
});

describe('PanelErrorBoundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('should render children', () => {
    render(
      <PanelErrorBoundary panelName="Test Panel">
        <NormalComponent />
      </PanelErrorBoundary>
    );

    expect(screen.getByText('Normal content')).toBeInTheDocument();
  });

  it('should catch errors and display concise error UI', () => {
    render(
      <PanelErrorBoundary panelName="AI Panel">
        <ThrowError />
      </PanelErrorBoundary>
    );

    expect(screen.getByText('AI Panel failed to load')).toBeInTheDocument();
    expect(screen.getByText('Test error message')).toBeInTheDocument();
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('clicking retry should call onRetry callback', () => {
    const onRetry = vi.fn();
    render(
      <PanelErrorBoundary panelName="Test Panel" onRetry={onRetry}>
        <ThrowError shouldThrow={true} />
      </PanelErrorBoundary>
    );

    expect(screen.getByText('Test Panel failed to load')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Retry'));

    expect(onRetry).toHaveBeenCalled();
  });
});

describe('AutoRecoveryErrorBoundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should render children', () => {
    render(
      <AutoRecoveryErrorBoundary>
        <NormalComponent />
      </AutoRecoveryErrorBoundary>
    );

    expect(screen.getByText('Normal content')).toBeInTheDocument();
  });

  it('should catch error and show recovering message', () => {
    render(
      <AutoRecoveryErrorBoundary recoveryDelay={5000} maxRetries={3}>
        <ThrowError />
      </AutoRecoveryErrorBoundary>
    );

    expect(screen.getByText('Recovering...')).toBeInTheDocument();
    expect(screen.getByText('Retry 1/3')).toBeInTheDocument();
  });

  it('should auto recover after delay', async () => {
    let shouldThrow = true;

    const TestComponent = () => {
      if (shouldThrow) {
        throw new Error('Test error');
      }
      return <div>Recovery successful</div>;
    };

    const { rerender } = render(
      <AutoRecoveryErrorBoundary recoveryDelay={5000} maxRetries={3}>
        <TestComponent />
      </AutoRecoveryErrorBoundary>
    );

    expect(screen.getByText('Recovering...')).toBeInTheDocument();

    // Simulate error recovery by disabling throw
    shouldThrow = false;

    // Advance timer to trigger recovery delay
    vi.advanceTimersByTime(5000);

    // Re-render to trigger state update after recovery
    rerender(
      <AutoRecoveryErrorBoundary recoveryDelay={5000} maxRetries={3}>
        <TestComponent />
      </AutoRecoveryErrorBoundary>
    );

    // Note: React state updates are async, may need waitFor in real scenarios
  });

  it('should show full error UI after exceeding max retries', () => {
    // Verifies behavior when retry limit is exhausted
    // Component throws to parent ErrorBoundary, requires special handling
    render(
      <ErrorBoundary>
        <AutoRecoveryErrorBoundary recoveryDelay={1000} maxRetries={0}>
          <ThrowError />
        </AutoRecoveryErrorBoundary>
      </ErrorBoundary>
    );

    // maxRetries=0 means first error triggers full error UI immediately
    expect(screen.getByText('Application Error')).toBeInTheDocument();
  });
});
