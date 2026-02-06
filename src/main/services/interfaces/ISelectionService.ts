/**
 * @file ISelectionService - Selection helper contract
 * @description Public interface for global selection capture (shortcut or hook)
 * @depends SelectionService
 */

import type { Event } from '@shared/utils';
import type { IDisposable } from '../ServiceContainer';

/**
 * Selection capture payload.
 */
export interface SelectionCaptureData {
  /** Selected text content. */
  text: string;
  /** Source application name. */
  sourceApp?: string;
  /** Capture timestamp (Unix). */
  capturedAt: number;
  /** Mouse/caret position. */
  cursorPosition?: { x: number; y: number };
}

/**
 * Selection helper configuration.
 */
export interface SelectionConfig {
  /** Whether service is enabled. */
  enabled: boolean;
  /** Trigger mode. */
  triggerMode: 'shortcut' | 'hook';
  /** Global shortcut. */
  shortcutKey: string;
  /** Default target knowledge base id. */
  defaultLibraryId?: string;
}

/**
 * Selection helper interface.
 */
export interface ISelectionService extends Partial<IDisposable> {
  // ====== Lifecycle ======

  /**
   * Starts selection capture service.
   * @sideeffect Registers global shortcut or starts global hook
   */
  start(): Promise<boolean>;

  /**
   * Stops selection capture service.
   * @sideeffect Unregisters shortcut or stops hook
   */
  stop(): void;

  /**
   * Checks whether service is running.
   */
  isRunning(): boolean;

  // ====== Configuration ======

  /**
   * Sets enabled state.
   */
  setEnabled(enabled: boolean): Promise<boolean>;

  /**
   * Returns enabled state.
   */
  isEnabled(): boolean;

  /**
   * Returns current configuration.
   */
  getConfig(): SelectionConfig;

  /**
   * Updates configuration.
   * @sideeffect May reconfigure hooks or shortcuts
   */
  updateConfig(config: Partial<SelectionConfig>): Promise<void>;

  // ====== Core Features ======

  /**
   * Captures current selection text.
   * @sideeffect Simulates clipboard copy to read selection
   */
  captureCurrentSelection(): Promise<SelectionCaptureData | null>;

  /**
   * Shows selection action window.
   * @param data Captured selection payload
   */
  showActionWindow(data: SelectionCaptureData): void;

  /**
   * Hides selection action window.
   */
  hideActionWindow(): void;

  /**
   * Hides selection toolbar.
   */
  hideToolbar(): void;

  // ====== Events ======

  /**
   * Selection captured event.
   */
  readonly onTextCaptured: Event<SelectionCaptureData>;
}
