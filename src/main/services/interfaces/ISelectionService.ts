/**
 * @file ISelectionService - Selection helper contract
 * @description Public interface for global selection capture (shortcut or hook)
 * @depends SelectionService
 */

import type { SelectionLifecycleResultDTO } from '@shared/ipc/types';
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
}

/**
 * Result of a lifecycle change, carrying the specific reason a failed
 * start / re-register can be surfaced to the user (shortcut already
 * bound, consent missing, hook load failed, etc.). Previous `boolean`
 * return silently ate the reason; consumers had to guess.
 *
 * Aliased to the wire DTO in `@shared/ipc/types`: IPC handlers already
 * pass-through service results with no field remapping, so the shape is
 * de facto one type. Aliasing (not just importing the `code` union) means
 * a new FIELD added to the DTO — not only a new code — is caught at
 * compile time on both sides in lockstep.
 */
export type SelectionLifecycleResult = SelectionLifecycleResultDTO;

/**
 * Selection helper interface.
 */
export interface ISelectionService extends Partial<IDisposable> {
  // ====== Lifecycle ======

  /**
   * Starts selection capture service.
   * @sideeffect Registers global shortcut or starts global hook
   */
  start(): Promise<SelectionLifecycleResult>;

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
  setEnabled(enabled: boolean): Promise<SelectionLifecycleResult>;

  /**
   * Returns enabled state.
   */
  isEnabled(): boolean;

  /**
   * Returns current configuration.
   */
  getConfig(): SelectionConfig;

  /**
   * Updates configuration. Returns the failure reason when a shortcut re-registration
   * or trigger-mode switch cannot bring the service back up — the caller is expected
   * to surface the reason and NOT treat a persistence write as evidence the runtime
   * is happy. On failure, the persisted config is rolled back to the previous values
   * so the UI + service stay in sync.
   * @sideeffect May reconfigure hooks or shortcuts; rolls back on failure
   */
  updateConfig(config: Partial<SelectionConfig>): Promise<SelectionLifecycleResult>;

  // ====== Core Features ======

  /**
   * Captures current selection text.
   * @sideeffect Simulates clipboard copy to read selection
   */
  captureCurrentSelection(): Promise<SelectionCaptureData | null>;

  // ====== Events ======

  /**
   * Selection captured event.
   */
  readonly onTextCaptured: Event<SelectionCaptureData>;
}
