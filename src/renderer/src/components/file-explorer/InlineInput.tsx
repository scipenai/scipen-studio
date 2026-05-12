/**
 * @file InlineInput.tsx - Inline edit input for file/folder creation and renaming
 * @description A focused text input that submits on Enter and cancels on Escape or blur.
 */

import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useRequestAnimationFrame } from '../../hooks';

export const InlineInput: React.FC<{
  defaultValue: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  placeholder?: string;
}> = ({ defaultValue, onSubmit, onCancel, placeholder }) => {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const isSubmittedRef = useRef(false);
  const scheduleFrame = useRequestAnimationFrame();

  useEffect(() => {
    const focusInput = () => {
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
      }
    };

    focusInput();
    // rAF backup ensures focus lands after the current animation frame completes.
    scheduleFrame(focusInput);
  }, [scheduleFrame]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation(); // Prevent triggering other shortcuts
    if (e.key === 'Enter') {
      if (value.trim() && !isSubmittedRef.current) {
        isSubmittedRef.current = true;
        onSubmit(value.trim());
      }
    } else if (e.key === 'Escape') {
      isSubmittedRef.current = true;
      onCancel();
    }
  };

  const handleBlur = () => {
    // Delay avoids a race with the Enter key handler that would commit twice.
    setTimeout(() => {
      if (!isSubmittedRef.current) {
        if (value.trim()) {
          onSubmit(value.trim());
        } else {
          onCancel();
        }
      }
    }, 100);
  };

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      placeholder={placeholder}
      className="w-full rounded px-2 py-0.5 text-sm outline-none"
      style={{
        background: 'var(--color-bg-tertiary)',
        border: '1px solid var(--color-accent)',
        color: 'var(--color-text-primary)',
      }}
      autoFocus
    />
  );
};
