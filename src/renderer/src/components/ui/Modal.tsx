/**
 * @file Modal.tsx - Modal component
 * @description Generic modal component supporting title, footer buttons, and keyboard close
 */

import { clsx } from 'clsx';
import { X } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from './IconButton';

const focusableSelector =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  /** Whether the modal is visible */
  open: boolean;
  /** Close callback */
  onClose: () => void;
  /** Modal title */
  title?: React.ReactNode;
  /** Modal description */
  description?: React.ReactNode;
  /** Modal content */
  children: React.ReactNode;
  /** Modal size */
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  /** Show close button */
  showCloseButton?: boolean;
  /** Close on overlay click */
  closeOnOverlayClick?: boolean;
  /** Close on ESC key */
  closeOnEsc?: boolean;
  /** Footer action area */
  footer?: React.ReactNode;
  /** Custom class name */
  className?: string;
  /** Disable body scroll (for custom scroll layouts) */
  noBodyScroll?: boolean;
}

/**
 * Modal component - SciPen Studio unified modal
 */
export const Modal: React.FC<ModalProps> = ({
  open,
  onClose,
  title,
  description,
  children,
  size = 'md',
  showCloseButton = true,
  closeOnOverlayClick = true,
  closeOnEsc = true,
  footer,
  className,
  noBodyScroll = false,
}) => {
  const generatedId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const titleId = title ? `modal-${generatedId.replace(/:/g, '')}-title` : undefined;
  const descriptionId = description
    ? `modal-${generatedId.replace(/:/g, '')}-description`
    : undefined;
  const sizeStyles = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-xl',
    full: 'max-w-[90vw] max-h-[90vh]',
  };

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && closeOnEsc) {
        onClose();
        return;
      }

      if (e.key === 'Tab') {
        const focusableElements = Array.from(
          dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? []
        );

        if (focusableElements.length === 0) {
          e.preventDefault();
          dialogRef.current?.focus();
          return;
        }

        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (e.shiftKey && document.activeElement === firstElement) {
          e.preventDefault();
          lastElement.focus();
        } else if (!e.shiftKey && document.activeElement === lastElement) {
          e.preventDefault();
          firstElement.focus();
        }
      }
    },
    [closeOnEsc, onClose]
  );

  useEffect(() => {
    if (open) {
      previouslyFocusedRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      document.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
      const focusTarget = dialogRef.current?.querySelector<HTMLElement>(focusableSelector);
      (focusTarget ?? dialogRef.current)?.focus();
      return () => {
        document.removeEventListener('keydown', handleKeyDown);
        document.body.style.overflow = '';
        previouslyFocusedRef.current?.focus();
        previouslyFocusedRef.current = null;
      };
    }
  }, [open, handleKeyDown]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in"
        onClick={closeOnOverlayClick ? onClose : undefined}
      />

      {/* Modal Content */}
      <div
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className={clsx(
          'relative w-full mx-4',
          'bg-[var(--color-bg-elevated)] rounded-xl',
          'border border-[var(--color-border)]',
          'shadow-[var(--shadow-lg)]',
          'animate-slide-up',
          sizeStyles[size],
          className
        )}
      >
        {/* Header */}
        {(title || showCloseButton) && (
          <div className="flex items-start justify-between p-4 border-b border-[var(--color-border)]">
            <div className="flex-1 min-w-0 pr-4">
              {title && (
                <h2 id={titleId} className="text-lg font-semibold text-[var(--color-text-primary)]">
                  {title}
                </h2>
              )}
              {description && (
                <p id={descriptionId} className="mt-1 text-sm text-[var(--color-text-muted)]">
                  {description}
                </p>
              )}
            </div>
            {showCloseButton && (
              <IconButton variant="ghost" size="sm" onClick={onClose} aria-label="Close">
                <X />
              </IconButton>
            )}
          </div>
        )}

        {/* Body */}
        <div className={clsx('p-4', !noBodyScroll && 'max-h-[60vh] overflow-y-auto')}>
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div className="flex items-center justify-end gap-3 p-4 border-t border-[var(--color-border)]">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};

Modal.displayName = 'Modal';

export default Modal;
