/**
 * @file SelectionService - Text selection assistant service
 * @description Main process service for global shortcuts, selection capture, and action window lifecycle.
 * @depends ConfigManager, selection-hook (native module), Electron globalShortcut/BrowserWindow
 * @implements ISelectionService
 */

import { createRequire } from 'module';
import { IpcChannel } from '@shared/ipc/channels';
import { Emitter } from '@shared/utils';
import { BrowserWindow, clipboard, globalShortcut, screen, systemPreferences } from 'electron';
import type {
  SelectionHookConstructor,
  SelectionHookInstance,
  TextSelectionData,
} from 'selection-hook';
import { ConfigKeys, configManager } from './ConfigManager';
import { createLogger } from './LoggerService';
import type {
  ISelectionService,
  SelectionCaptureData,
  SelectionConfig,
} from './interfaces/ISelectionService';

const logger = createLogger('SelectionService');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isHookSupported = isWin || isMac;
const isDev = process.env.NODE_ENV === 'development';

let SelectionHook: SelectionHookConstructor | null = null;
if (isHookSupported) {
  try {
    const require = createRequire(import.meta.url);
    SelectionHook = require('selection-hook');
  } catch (error) {
    logger.error('[SelectionService] Failed to load selection-hook:', error);
  }
}

// ====== Default Configuration ======

const DEFAULT_CONFIG: SelectionConfig = {
  enabled: false,
  triggerMode: 'shortcut',
  shortcutKey: 'Alt+D',
};

// ====== Window Dimensions ======

type SelectionHookPosition = { x: number; y: number };
type SelectionHookData = TextSelectionData & {
  mousePosStart?: SelectionHookPosition;
  mousePosEnd?: SelectionHookPosition;
  programName?: string;
};

export class SelectionService implements ISelectionService {
  private actionWindow: BrowserWindow | null = null;
  private toolbarWindow: BrowserWindow | null = null;
  private config: SelectionConfig = { ...DEFAULT_CONFIG };
  private started = false;
  private cachedSelection: SelectionCaptureData | null = null;
  private shortcutRegistered = false;
  private hookRunning = false;
  private hookListenersBound = false;
  private selectionHook: SelectionHookInstance | null = null;

  private readonly _onTextCaptured = new Emitter<SelectionCaptureData>();
  readonly onTextCaptured = this._onTextCaptured.event;

  constructor() {
    logger.info('[SelectionService] Instance created');

    // Load persisted config from ConfigManager
    this.loadConfig();

    if (SelectionHook) {
      try {
        this.selectionHook = new SelectionHook();
      } catch (error) {
        logger.error('[SelectionService] Failed to initialize selection-hook:', error);
        this.selectionHook = null;
      }
    }
  }

  /**
   * Loads configuration from ConfigManager.
   */
  private loadConfig(): void {
    try {
      const enabled = configManager.get<boolean>(ConfigKeys.SelectionEnabled);
      const triggerMode = configManager.get<'shortcut' | 'hook'>(ConfigKeys.SelectionTriggerMode);
      const shortcutKey = configManager.get<string>(ConfigKeys.SelectionShortcutKey);

      this.config = {
        enabled: enabled ?? DEFAULT_CONFIG.enabled,
        triggerMode: triggerMode ?? DEFAULT_CONFIG.triggerMode,
        shortcutKey: shortcutKey ?? DEFAULT_CONFIG.shortcutKey,
      };

      logger.info('[SelectionService] Config loaded:', this.config);
    } catch (error) {
      logger.error('[SelectionService] Failed to load config, using defaults:', error);
      this.config = { ...DEFAULT_CONFIG };
    }
  }

  /**
   * Saves configuration to ConfigManager.
   */
  private saveConfig(): void {
    try {
      configManager.set(ConfigKeys.SelectionEnabled, this.config.enabled);
      configManager.set(ConfigKeys.SelectionTriggerMode, this.config.triggerMode);
      configManager.set(ConfigKeys.SelectionShortcutKey, this.config.shortcutKey);
      logger.debug('[SelectionService] Config saved');
    } catch (error) {
      logger.error('[SelectionService] Failed to save config:', error);
    }
  }

  // ====== Lifecycle ======

  async start(): Promise<boolean> {
    if (this.started) {
      logger.warn('[SelectionService] Service already running');
      return true;
    }

    try {
      if (this.config.triggerMode === 'hook') {
        const started = await this.startHookMode();
        if (!started) {
          return false;
        }
      } else {
        this.registerShortcut();
        // In shortcut mode, try starting hook for getCurrentSelection (non-blocking on failure)
        const hookStarted = await this.startHookMode();
        if (!hookStarted) {
          logger.warn(
            '[SelectionService] Hook start failed in shortcut mode, falling back to clipboard'
          );
        }
      }

      this.started = true;
      logger.info('[SelectionService] Service started');
      return true;
    } catch (error) {
      this.cleanupAfterFailedStart();
      logger.error(`[SelectionService] Failed to start: ${this.formatError(error)}`);
      return false;
    }
  }

  stop(): void {
    if (!this.started) {
      return;
    }

    // Unregister global shortcut
    this.unregisterShortcut();

    // Stop global selection hook
    this.stopHookMode();

    // Hide and destroy ActionWindow
    if (this.actionWindow && !this.actionWindow.isDestroyed()) {
      this.actionWindow.close();
      this.actionWindow = null;
    }

    // Hide and destroy ToolbarWindow
    if (this.toolbarWindow && !this.toolbarWindow.isDestroyed()) {
      this.toolbarWindow.close();
      this.toolbarWindow = null;
    }

    this.started = false;
    logger.info('[SelectionService] Service stopped');
  }

  isRunning(): boolean {
    return this.started;
  }

  dispose(): void {
    this.stop();
    this._onTextCaptured.dispose();
    logger.info('[SelectionService] Service disposed');
  }

  // ====== Configuration ======

  async setEnabled(enabled: boolean): Promise<boolean> {
    this.config.enabled = enabled;
    this.saveConfig();
    logger.info(`[SelectionService] Enabled state: ${enabled}`);

    if (enabled && !this.started) {
      return await this.start();
    }

    if (!enabled && this.started) {
      this.stop();
    }

    return true;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  getConfig(): SelectionConfig {
    return { ...this.config };
  }

  async updateConfig(config: Partial<SelectionConfig>): Promise<void> {
    const oldShortcut = this.config.shortcutKey;
    const oldTriggerMode = this.config.triggerMode;
    this.config = { ...this.config, ...config };

    // Persist configuration
    this.saveConfig();

    // Re-register shortcut if changed
    if (config.shortcutKey && config.shortcutKey !== oldShortcut && this.started) {
      if (this.config.triggerMode === 'shortcut') {
        this.unregisterShortcut();
        this.registerShortcut();
      }
    }

    // Restart service when trigger mode changes
    if (config.triggerMode && config.triggerMode !== oldTriggerMode && this.started) {
      this.stop();
      if (this.config.enabled) {
        await this.start();
      }
    }

    // Try starting if enabled but not running (recovery from failed start)
    if (this.config.enabled && !this.started) {
      await this.start();
    }

    logger.info('[SelectionService] Config updated:', this.config);
  }

  // ====== Core Features ======

  async captureCurrentSelection(): Promise<SelectionCaptureData | null> {
    try {
      // Prefer selection-hook for getting current selection
      const hookSelection = this.captureFromHook();
      if (hookSelection) {
        this.cachedSelection = hookSelection;
        this._onTextCaptured.fire(hookSelection);
        return hookSelection;
      }

      // Phase 1: Read selection via clipboard
      // 1. Save current clipboard content
      const originalClipboard = clipboard.readText();

      // 2. Clear clipboard
      clipboard.clear();

      // 3. Simulate Ctrl+C (via robotjs or nut.js, using clipboard method here)
      // Note: Full implementation requires robotjs or @nut-tree/nut-js
      // Assumes user has copied text or copy is triggered elsewhere
      await this.simulateCopy();

      // 4. Wait for clipboard update
      await this.sleep(100);

      // 5. Read new clipboard content
      const selectedText = clipboard.readText();

      // 6. Restore original clipboard
      if (originalClipboard) {
        // Delay restore to avoid overwriting just-copied content
        setTimeout(() => {
          clipboard.writeText(originalClipboard);
        }, 500);
      }

      if (!selectedText || selectedText.trim() === '') {
        logger.debug('[SelectionService] No text captured');
        return null;
      }

      const data: SelectionCaptureData = {
        text: selectedText.trim(),
        capturedAt: Date.now(),
        cursorPosition: this.getCursorPosition(),
      };

      this.cachedSelection = data;
      this._onTextCaptured.fire(data);

      logger.info(`[SelectionService] Captured text: ${data.text.substring(0, 50)}...`);
      return data;
    } catch (error) {
      logger.error('[SelectionService] Failed to capture selection:', error);
      return null;
    }
  }

  // ====== Internal Methods ======

  private getCursorPosition(): { x: number; y: number } {
    const cursor = screen.getCursorScreenPoint();
    return { x: cursor.x, y: cursor.y };
  }

  private registerShortcut(): void {
    if (this.shortcutRegistered) {
      return;
    }

    const shortcut = this.config.shortcutKey;
    const success = globalShortcut.register(shortcut, async () => {
      if (!this.config.enabled) {
        return;
      }

      logger.debug(`[SelectionService] Shortcut triggered: ${shortcut}`);

      const data = await this.captureCurrentSelection();
      if (data?.text.trim()) {
        this.sendCapturedTextToMainWindow(data.text);
      }
    });

    if (success) {
      this.shortcutRegistered = true;
      logger.info(`[SelectionService] Global shortcut registered: ${shortcut}`);
    } else {
      logger.error(`[SelectionService] Failed to register shortcut: ${shortcut}`);
    }
  }

  private unregisterShortcut(): void {
    if (!this.shortcutRegistered) {
      return;
    }

    const shortcut = this.config.shortcutKey;
    globalShortcut.unregister(shortcut);
    this.shortcutRegistered = false;
    logger.info(`[SelectionService] Global shortcut unregistered: ${shortcut}`);
  }

  private async simulateCopy(): Promise<void> {
    // Phase 1: Simple implementation - assumes user has already copied text
    // Full implementation requires robotjs or @nut-tree/nut-js for key simulation
    // e.g.: robot.keyTap('c', ['control']);

    // Here we rely on user having selected and copied text before pressing shortcut
    // or copy triggered elsewhere

    // For auto-copy, can use @jitsi/oce-robotjs or nutjs
    // Left empty for now, pending future integration
    logger.debug('[SelectionService] simulateCopy called (requires robotjs for auto-copy)');
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}`;
    }
    return String(error);
  }

  private cleanupAfterFailedStart(): void {
    this.unregisterShortcut();
    this.stopHookMode();

    if (this.actionWindow && !this.actionWindow.isDestroyed()) {
      this.actionWindow.close();
      this.actionWindow = null;
    }

    if (this.toolbarWindow && !this.toolbarWindow.isDestroyed()) {
      this.toolbarWindow.close();
      this.toolbarWindow = null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async startHookMode(): Promise<boolean> {
    logger.info('[SelectionService] Attempting to start Hook mode...');
    logger.info(
      `[SelectionService] isHookSupported: ${isHookSupported}, SelectionHook loaded: ${!!SelectionHook}`
    );

    if (!isHookSupported || !SelectionHook) {
      logger.warn(
        '[SelectionService] selection-hook not supported on current platform or not loaded'
      );
      return false;
    }

    if (!this.selectionHook) {
      try {
        logger.info('[SelectionService] Creating SelectionHook instance...');
        this.selectionHook = new SelectionHook();
        logger.info('[SelectionService] SelectionHook instance created');
      } catch (error) {
        logger.error('[SelectionService] Failed to create selection-hook:', error);
        return false;
      }
    }

    // macOS accessibility permission check
    if (isMac && !systemPreferences.isTrustedAccessibilityClient(false)) {
      // Try to trigger permission prompt
      systemPreferences.isTrustedAccessibilityClient(true);
      logger.warn(
        '[SelectionService] Accessibility permission not granted, cannot enable selection hook'
      );
      return false;
    }

    if (!this.hookListenersBound) {
      logger.info('[SelectionService] Binding Hook event listeners...');
      this.selectionHook.on('error', (error: { message?: string }) => {
        logger.error('[SelectionService] selection-hook error:', error);
      });
      this.selectionHook.on('text-selection', this.handleTextSelection);
      this.hookListenersBound = true;
      logger.info('[SelectionService] Hook event listeners bound');
    }

    logger.info('[SelectionService] Starting selection-hook...');
    const started = this.selectionHook.start({ debug: isDev });
    if (!started) {
      logger.error('[SelectionService] selection-hook failed to start');
      return false;
    }
    logger.info('[SelectionService] selection-hook started');

    this.hookRunning = true;
    logger.info('[SelectionService] Hook mode started successfully');
    return true;
  }

  private stopHookMode(): void {
    if (!this.selectionHook || !this.hookRunning) {
      return;
    }

    try {
      this.selectionHook.stop();
      if (typeof this.selectionHook.cleanup === 'function') {
        this.selectionHook.cleanup();
      }
    } catch (error) {
      logger.error('[SelectionService] Failed to stop selection-hook:', error);
    } finally {
      this.hookRunning = false;
      this.hookListenersBound = false;
    }
  }

  private captureFromHook(): SelectionCaptureData | null {
    if (!this.selectionHook || typeof this.selectionHook.getCurrentSelection !== 'function') {
      return null;
    }

    const selectionData = this.selectionHook.getCurrentSelection() as SelectionHookData | null;
    if (!selectionData || !selectionData.text) {
      return null;
    }

    return {
      text: selectionData.text.trim(),
      sourceApp: selectionData.programName,
      capturedAt: Date.now(),
      cursorPosition: selectionData.mousePosEnd
        ? { x: selectionData.mousePosEnd.x, y: selectionData.mousePosEnd.y }
        : this.getCursorPosition(),
    };
  }

  private handleTextSelection = (selectionData: SelectionHookData): void => {
    logger.info('[SelectionService] handleTextSelection triggered');

    if (!this.config.enabled || this.config.triggerMode !== 'hook') {
      logger.info(
        `[SelectionService] Ignored: enabled=${this.config.enabled}, triggerMode=${this.config.triggerMode}`
      );
      return;
    }

    if (!selectionData || !selectionData.text || selectionData.text.trim() === '') {
      logger.info('[SelectionService] Ignored: empty text');
      return;
    }

    logger.info('[SelectionService] Hook captured text:', selectionData.text.substring(0, 50));

    const data: SelectionCaptureData = {
      text: selectionData.text.trim(),
      sourceApp: selectionData.programName,
      capturedAt: Date.now(),
      cursorPosition: selectionData.mousePosEnd
        ? { x: selectionData.mousePosEnd.x, y: selectionData.mousePosEnd.y }
        : this.getCursorPosition(),
    };

    this.cachedSelection = data;
    this._onTextCaptured.fire(data);
    this.sendCapturedTextToMainWindow(data.text);
  };

  /**
   * Sends captured text to the currently focused window (accurate routing in multi-window setups).
   */
  private sendCapturedTextToMainWindow(text: string): void {
    // Prefer the focused window so text doesn't end up in the wrong one
    let targetWin = BrowserWindow.getFocusedWindow();
    if (!targetWin || targetWin.isDestroyed()) {
      // Fall back to the most recent non-auxiliary window when nothing is focused
      targetWin =
        BrowserWindow.getAllWindows().find(
          (w) => w !== this.actionWindow && w !== this.toolbarWindow && !w.isDestroyed()
        ) ?? null;
    }
    if (targetWin) {
      targetWin.webContents.send(IpcChannel.Selection_TextCaptured, {
        text,
        capturedAt: new Date().toISOString(),
      });
      if (targetWin.isMinimized()) targetWin.restore();
      targetWin.focus();
      logger.info(
        `[SelectionService] Sent captured text to window ${targetWin.id} (${text.length} chars)`
      );
    } else {
      logger.warn('[SelectionService] No window found to send captured text');
    }
  }

  /**
   * Gets cached selection data.
   */
  getCachedSelection(): SelectionCaptureData | null {
    return this.cachedSelection;
  }
}
