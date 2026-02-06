/**
 * SciPen Studio - Global Error Boundary Component
 *
 * References VS Code and Cherry Studio error handling design
 * Catches errors in React component tree to prevent entire app crash
 */

import { AlertTriangle, ChevronDown, ChevronUp, Copy, RefreshCw } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { t } from '../locales';
import { createLogger } from '../services/LogService';

const logger = createLogger('ErrorBoundary');

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  showDetails: boolean;
}

/**
 * Global error boundary component
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      showDetails: false,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Log error to logging service
    logger.error('React component error caught', {
      error: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
    });

    this.setState({ errorInfo });

    // Call external error handler callback
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }
  }

  handleReload = (): void => {
    window.location.reload();
  };

  handleReset = (): void => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      showDetails: false,
    });
  };

  handleCopyError = (): void => {
    const { error, errorInfo } = this.state;
    const errorText = `
Error: ${error?.message}

Stack Trace:
${error?.stack}

Component Stack:
${errorInfo?.componentStack}

Time: ${new Date().toISOString()}
User Agent: ${navigator.userAgent}
    `.trim();

    navigator.clipboard.writeText(errorText).then(() => {
      logger.info('Error details copied to clipboard');
    });
  };

  toggleDetails = (): void => {
    this.setState((prev) => ({ showDetails: !prev.showDetails }));
  };

  render(): ReactNode {
    const { hasError, error, errorInfo, showDetails } = this.state;
    const { children, fallback } = this.props;

    if (hasError) {
      if (fallback) {
        return fallback;
      }

      return (
        <div className="min-h-screen bg-[var(--color-bg-void)] flex items-center justify-center p-8">
          <div className="max-w-2xl w-full bg-[var(--color-bg-secondary)] rounded-lg shadow-xl overflow-hidden">
            <div className="bg-[var(--color-error-muted)] border-b border-[var(--color-error)]/30 px-6 py-4 flex items-center gap-3">
              <div className="p-2 bg-[var(--color-error)]/20 rounded-full">
                <AlertTriangle className="w-6 h-6 text-[var(--color-error)]" />
              </div>
              <div>
                <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">
                  {t('errorBoundary.title')}
                </h1>
                <p className="text-sm text-[var(--color-text-muted)]">
                  {t('errorBoundary.description')}
                </p>
              </div>
            </div>

            <div className="p-6 space-y-4">
              <div className="bg-[var(--color-bg-primary)] rounded-lg p-4">
                <p className="text-[var(--color-error)] font-mono text-sm break-all">
                  {error?.message || t('errorBoundary.unknownError')}
                </p>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={this.handleReset}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-[var(--color-accent)] hover:brightness-110 text-white rounded-lg transition-all"
                >
                  <RefreshCw size={16} />
                  {t('errorBoundary.retry')}
                </button>
                <button
                  onClick={this.handleReload}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-hover)] text-[var(--color-text-primary)] rounded-lg transition-colors"
                >
                  <RefreshCw size={16} />
                  {t('errorBoundary.reload')}
                </button>
                <button
                  onClick={this.handleCopyError}
                  className="flex items-center justify-center gap-2 px-4 py-2 bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-hover)] text-[var(--color-text-primary)] rounded-lg transition-colors"
                  title={t('errorBoundary.copyError')}
                >
                  <Copy size={16} />
                </button>
              </div>

              <div className="border-t border-[var(--color-border)] pt-4">
                <button
                  onClick={this.toggleDetails}
                  className="flex items-center gap-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
                >
                  {showDetails ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  {showDetails ? t('errorBoundary.hideDetails') : t('errorBoundary.showDetails')}
                </button>

                {showDetails && (
                  <div className="mt-4 space-y-4">
                    {error?.stack && (
                      <div>
                        <h3 className="text-sm font-medium text-[var(--color-text-secondary)] mb-2">
                          {t('errorBoundary.stackTrace')}
                        </h3>
                        <pre className="bg-[var(--color-bg-primary)] rounded-lg p-4 text-xs text-[var(--color-text-muted)] overflow-x-auto max-h-48 overflow-y-auto">
                          {error.stack}
                        </pre>
                      </div>
                    )}

                    {errorInfo?.componentStack && (
                      <div>
                        <h3 className="text-sm font-medium text-[var(--color-text-secondary)] mb-2">
                          {t('errorBoundary.componentStack')}
                        </h3>
                        <pre className="bg-[var(--color-bg-primary)] rounded-lg p-4 text-xs text-[var(--color-text-muted)] overflow-x-auto max-h-48 overflow-y-auto">
                          {errorInfo.componentStack}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="text-sm text-[var(--color-text-muted)]">
                <p>{t('errorBoundary.persistentError')}</p>
                <ul className="list-disc list-inside mt-2 space-y-1">
                  <li>{t('errorBoundary.clearCache')}</li>
                  <li>{t('errorBoundary.checkUnsaved')}</li>
                  <li>
                    <a
                      href="https://github.com/anthropics/claude-code/issues"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--color-accent)] hover:underline"
                    >
                      {t('errorBoundary.reportIssue')}
                    </a>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return children;
  }
}

/**
 * Error boundary with auto-recovery functionality
 * Automatically attempts recovery after a certain time
 */
interface AutoRecoveryProps extends Props {
  recoveryDelay?: number;
  maxRetries?: number;
}

interface AutoRecoveryState extends State {
  retryCount: number;
}

export class AutoRecoveryErrorBoundary extends Component<AutoRecoveryProps, AutoRecoveryState> {
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(props: AutoRecoveryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      showDetails: false,
      retryCount: 0,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<AutoRecoveryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const { recoveryDelay = 5000, maxRetries = 3, onError } = this.props;
    const { retryCount } = this.state;

    logger.error('React component error caught (auto-recovery)', {
      error: error.message,
      retryCount,
      maxRetries,
    });

    this.setState({ errorInfo });

    if (onError) {
      onError(error, errorInfo);
    }

    // Auto-recovery
    if (retryCount < maxRetries) {
      this.recoveryTimer = setTimeout(() => {
        this.setState((prev) => ({
          hasError: false,
          error: null,
          errorInfo: null,
          retryCount: prev.retryCount + 1,
        }));
      }, recoveryDelay);
    }
  }

  componentWillUnmount(): void {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
    }
  }

  render(): ReactNode {
    const { hasError, error, retryCount } = this.state;
    const { children, maxRetries = 3 } = this.props;

    if (hasError) {
      if (retryCount >= maxRetries) {
        // Exceeded max retries, show full error UI
        return (
          <ErrorBoundary>
            {(() => {
              throw error;
            })()}
          </ErrorBoundary>
        );
      }

      return (
        <div className="flex items-center justify-center p-8">
          <div className="text-center">
            <RefreshCw className="w-8 h-8 text-[var(--color-accent)] animate-spin mx-auto mb-4" />
            <p className="text-[var(--color-text-secondary)]">{t('errorBoundary.recovering')}</p>
            <p className="text-sm text-[var(--color-text-muted)] mt-1">
              {t('errorBoundary.retryCount', { current: retryCount + 1, max: maxRetries })}
            </p>
          </div>
        </div>
      );
    }

    return children;
  }
}

/**
 * Lightweight panel error boundary
 * Wraps child components, shows concise error message instead of full-screen error page
 */
interface PanelErrorBoundaryProps {
  children: ReactNode;
  panelName: string;
  onRetry?: () => void;
}

interface PanelErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class PanelErrorBoundary extends Component<
  PanelErrorBoundaryProps,
  PanelErrorBoundaryState
> {
  constructor(props: PanelErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<PanelErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    logger.error(`Panel error in ${this.props.panelName}`, {
      error: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
    });
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
    this.props.onRetry?.();
  };

  render(): ReactNode {
    const { hasError, error } = this.state;
    const { children, panelName } = this.props;

    if (hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-full p-4 bg-[var(--color-bg-primary)]/50">
          <AlertTriangle className="w-8 h-8 text-[var(--color-warning)] mb-3" />
          <p className="text-sm text-[var(--color-text-secondary)] mb-1">
            {t('errorBoundary.panelLoadFailed', { name: panelName })}
          </p>
          <p className="text-xs text-[var(--color-text-muted)] mb-3 max-w-xs text-center truncate">
            {error?.message || t('errorBoundary.unknownError')}
          </p>
          <button
            onClick={this.handleRetry}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-hover)] text-[var(--color-text-primary)] rounded transition-colors"
          >
            <RefreshCw size={12} />
            {t('errorBoundary.retry')}
          </button>
        </div>
      );
    }

    return children;
  }
}
