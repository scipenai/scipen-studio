/**
 * @file SelectionService - Text selection assistant service
 * @description Main process service for global shortcuts, selection capture, and action window lifecycle.
 * @depends ConfigManager, selection-hook (native module), Electron globalShortcut/BrowserWindow
 * @implements ISelectionService
 */

import { createRequire } from 'module';
import { join } from 'path';
import { IpcChannel } from '@shared/ipc/channels';
import { Emitter } from '@shared/utils';
import { BrowserWindow, app, clipboard, globalShortcut, screen, systemPreferences } from 'electron';
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
  defaultLibraryId: undefined,
};

// ====== Window Dimensions ======

const ACTION_WINDOW_WIDTH = 420;
const ACTION_WINDOW_HEIGHT = 460;
const TOOLBAR_WIDTH = 320;
const TOOLBAR_HEIGHT = 56;

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
      const defaultLibraryId = configManager.get<string>(ConfigKeys.SelectionDefaultLibraryId);

      this.config = {
        enabled: enabled ?? DEFAULT_CONFIG.enabled,
        triggerMode: triggerMode ?? DEFAULT_CONFIG.triggerMode,
        shortcutKey: shortcutKey ?? DEFAULT_CONFIG.shortcutKey,
        defaultLibraryId: defaultLibraryId ?? DEFAULT_CONFIG.defaultLibraryId,
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
      if (this.config.defaultLibraryId) {
        configManager.set(ConfigKeys.SelectionDefaultLibraryId, this.config.defaultLibraryId);
      }
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

      // Pre-create ActionWindow (hidden state)
      await this.ensureActionWindow();

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

  showActionWindow(data: SelectionCaptureData): void {
    // Hide toolbar if exists
    if (this.toolbarWindow && !this.toolbarWindow.isDestroyed()) {
      this.toolbarWindow.hide();
    }

    if (!this.actionWindow || this.actionWindow.isDestroyed()) {
      logger.warn('[SelectionService] ActionWindow does not exist, creating...');
      this.ensureActionWindow().then(() => {
        this.doShowActionWindow(data);
      });
      return;
    }

    this.doShowActionWindow(data);
  }

  hideActionWindow(): void {
    if (this.actionWindow && !this.actionWindow.isDestroyed()) {
      this.actionWindow.hide();
      logger.debug('[SelectionService] ActionWindow hidden');
    }
  }

  hideToolbar(): void {
    if (this.toolbarWindow && !this.toolbarWindow.isDestroyed()) {
      this.toolbarWindow.hide();
      logger.debug('[SelectionService] ToolbarWindow hidden');
    }
  }

  // ====== Internal Methods ======

  private getPreloadPath(): string {
    const appRoot = process.env.APP_ROOT ?? app.getAppPath();
    return join(appRoot, 'out', 'preload', 'index.mjs');
  }

  private async ensureActionWindow(): Promise<BrowserWindow> {
    if (this.actionWindow && !this.actionWindow.isDestroyed()) {
      return this.actionWindow;
    }

    logger.info('[SelectionService] Creating ActionWindow...');

    const preloadPath = this.getPreloadPath();
    this.actionWindow = new BrowserWindow({
      width: ACTION_WINDOW_WIDTH,
      height: ACTION_WINDOW_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: true,
      skipTaskbar: true,
      focusable: true,
      alwaysOnTop: true,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        // sandbox: false allows ESM preload scripts to load properly
        sandbox: false,
        // Security baseline: explicitly enable web security
        webSecurity: true,
        // Disable DevTools in production
        devTools: isDev,
      },
    });
    const actionWindow = this.actionWindow;

    // Monitor load failures and render crashes
    actionWindow.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL) => {
        logger.error(
          `[SelectionService] ActionWindow load failed: code=${errorCode}, desc=${errorDescription}, url=${validatedURL}`
        );
      }
    );
    actionWindow.webContents.on('render-process-gone', (_event, details) => {
      logger.error('[SelectionService] ActionWindow render process crashed:', details);
    });
    if (isDev) {
      actionWindow.webContents.on('console-message', (_event, level, message) => {
        logger.info(`[SelectionService] ActionWindow console: level=${level}, message=${message}`);
      });
    }
    actionWindow.webContents.on('did-finish-load', () => {
      logger.info('[SelectionService] ActionWindow did-finish-load');
    });

    // Load ActionWindow page
    await this.loadWindowContent(actionWindow, 'selectionAction.html');

    if (actionWindow.isDestroyed()) {
      logger.warn('[SelectionService] ActionWindow destroyed during load');
      return actionWindow;
    }

    // Clean up reference when window closes
    actionWindow.on('closed', () => {
      if (this.actionWindow === actionWindow) {
        this.actionWindow = null;
      }
    });

    // Hide on blur
    actionWindow.on('blur', () => {
      // Delay hide to avoid hiding when clicking internal elements
      setTimeout(() => {
        if (this.actionWindow && !this.actionWindow.isFocused()) {
          this.hideActionWindow();
        }
      }, 200);
    });

    logger.info('[SelectionService] ActionWindow created');
    return actionWindow;
  }

  private async ensureToolbarWindow(): Promise<BrowserWindow> {
    if (this.toolbarWindow && !this.toolbarWindow.isDestroyed()) {
      return this.toolbarWindow;
    }

    logger.info('[SelectionService] Creating ToolbarWindow...');

    const preloadPath = this.getPreloadPath();
    this.toolbarWindow = new BrowserWindow({
      width: TOOLBAR_WIDTH,
      height: TOOLBAR_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      thickFrame: false,
      // Windows: type=toolbar + focusable=false prevents focus stealing
      // macOS: type=panel supports fullscreen apps
      ...(isWin ? { type: 'toolbar', focusable: false } : { type: 'panel' }),
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        // sandbox: false allows ESM preload scripts to load properly
        sandbox: false,
        // Security baseline: explicitly enable web security
        webSecurity: true,
        // Disable DevTools in production
        devTools: isDev,
      },
    });
    const toolbarWindow = this.toolbarWindow;

    // Monitor load failures and render crashes
    toolbarWindow.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL) => {
        logger.error(
          `[SelectionService] ToolbarWindow load failed: code=${errorCode}, desc=${errorDescription}, url=${validatedURL}`
        );
      }
    );
    toolbarWindow.webContents.on('render-process-gone', (_event, details) => {
      logger.error('[SelectionService] ToolbarWindow render process crashed:', details);
    });
    if (isDev) {
      toolbarWindow.webContents.on('console-message', (_event, level, message) => {
        logger.info(`[SelectionService] ToolbarWindow console: level=${level}, message=${message}`);
      });
    }
    toolbarWindow.webContents.on('did-finish-load', () => {
      logger.info('[SelectionService] ToolbarWindow did-finish-load');
    });

    await this.loadWindowContent(toolbarWindow, 'selectionToolbar.html');

    if (toolbarWindow.isDestroyed()) {
      logger.warn('[SelectionService] ToolbarWindow destroyed during load');
      return toolbarWindow;
    }

    toolbarWindow.on('closed', () => {
      if (this.toolbarWindow === toolbarWindow) {
        this.toolbarWindow = null;
      }
    });

    // Note: Don't hide toolbar on blur since user may select text in other apps
    // Toolbar closes manually on button click or Esc key

    logger.info('[SelectionService] ToolbarWindow created');
    return toolbarWindow;
  }

  private doShowActionWindow(data: SelectionCaptureData): void {
    if (!this.actionWindow || this.actionWindow.isDestroyed()) {
      logger.warn('[SelectionService] doShowActionWindow: window does not exist or destroyed');
      return;
    }

    this.cachedSelection = data;

    // Calculate window position (near cursor, prevent overflow)
    const position = this.calculateWindowPosition();
    logger.info(`[SelectionService] Window position: x=${position.x}, y=${position.y}`);
    this.actionWindow.setPosition(position.x, position.y, false);

    // Send data to ActionWindow
    this.actionWindow.webContents.send(IpcChannel.Selection_TextCaptured, {
      text: data.text,
      sourceApp: data.sourceApp,
      capturedAt: new Date(data.capturedAt).toISOString(),
      cursorPosition: data.cursorPosition,
    });

    // Show window
    this.actionWindow.show();
    this.actionWindow.focus();

    logger.info('[SelectionService] ActionWindow shown, text length:', data.text.length);
  }

  private async showToolbarWindow(data: SelectionCaptureData): Promise<void> {
    logger.info('[SelectionService] showToolbarWindow called, text length:', data.text.length);

    const toolbar = await this.ensureToolbarWindow();

    // Convert coordinates first (following Cherry Studio approach)
    let refPoint = data.cursorPosition ?? screen.getCursorScreenPoint();

    // selection-hook returns physical pixel coordinates, need to convert to logical (DIP)
    // macOS doesn't need conversion, Windows/Linux do
    if (!isMac && data.cursorPosition) {
      refPoint = screen.screenToDipPoint(refPoint);
    }
    refPoint = { x: Math.round(refPoint.x), y: Math.round(refPoint.y) };

    // Get display info (using converted coordinates)
    const display = screen.getDisplayNearestPoint(refPoint);
    logger.info(
      `[SelectionService] Display info: workArea=${JSON.stringify(display.workArea)}, refPoint=${JSON.stringify(refPoint)}`
    );

    const position = this.calculateToolbarPositionFromPoint(refPoint, display.workArea);
    logger.info(`[SelectionService] Toolbar position: x=${position.x}, y=${position.y}`);

    // Use setBounds instead of just setPosition (following Cherry Studio)
    toolbar.setPosition(position.x, position.y, false);
    toolbar.setBounds({
      x: position.x,
      y: position.y,
      width: TOOLBAR_WIDTH,
      height: TOOLBAR_HEIGHT,
    });

    // Ensure window is on top
    toolbar.setAlwaysOnTop(true, 'screen-saver');

    // Ensure webContents is loaded before sending data
    const sendData = () => {
      toolbar.webContents.send(IpcChannel.Selection_TextCaptured, {
        text: data.text,
        sourceApp: data.sourceApp,
        capturedAt: new Date(data.capturedAt).toISOString(),
        cursorPosition: data.cursorPosition,
      });
      logger.info('[SelectionService] IPC data sent to ToolbarWindow');
    };

    if (toolbar.webContents.isLoading()) {
      logger.info('[SelectionService] ToolbarWindow loading, waiting...');
      toolbar.webContents.once('did-finish-load', sendData);
    } else {
      sendData();
    }

    // Key: Windows and macOS use different display methods (following Cherry Studio)
    if (!isMac) {
      // [Windows] Use show() since focusable: false is already set
      toolbar.show();
      toolbar.moveTop();
      toolbar.setAlwaysOnTop(true, 'screen-saver');
      logger.info('[SelectionService] ToolbarWindow shown (Windows: show)');
    } else {
      // [macOS] Use showInactive() to prevent bringing other windows forward
      toolbar.showInactive();
      logger.info('[SelectionService] ToolbarWindow shown (macOS: showInactive)');
    }

    const bounds = toolbar.getBounds();
    logger.info(
      `[SelectionService] ToolbarWindow state: visible=${toolbar.isVisible()}, bounds=${JSON.stringify(
        bounds
      )}`
    );
  }

  // Calculate toolbar position from converted coordinate point
  private calculateToolbarPositionFromPoint(
    refPoint: { x: number; y: number },
    workArea: { x: number; y: number; width: number; height: number }
  ): { x: number; y: number } {
    // Show toolbar below and to the right of cursor
    let x = refPoint.x + 8;
    let y = refPoint.y + 16;

    // Ensure window stays within screen
    if (x + TOOLBAR_WIDTH > workArea.x + workArea.width) {
      x = workArea.x + workArea.width - TOOLBAR_WIDTH - 8;
    }

    if (y + TOOLBAR_HEIGHT > workArea.y + workArea.height) {
      // If not enough space below, show above cursor
      y = refPoint.y - TOOLBAR_HEIGHT - 8;
    }

    // Check bounds again
    if (y + TOOLBAR_HEIGHT > workArea.y + workArea.height) {
      y = workArea.y + workArea.height - TOOLBAR_HEIGHT - 8;
    }

    x = Math.max(workArea.x + 8, x);
    y = Math.max(workArea.y + 8, y);

    return { x: Math.round(x), y: Math.round(y) };
  }

  private calculateWindowPosition(): { x: number; y: number } {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const workArea = display.workArea;

    let x = cursor.x + 10;
    let y = cursor.y + 10;

    // Prevent window from exceeding right edge
    if (x + ACTION_WINDOW_WIDTH > workArea.x + workArea.width) {
      x = workArea.x + workArea.width - ACTION_WINDOW_WIDTH - 10;
    }

    // Prevent window from exceeding bottom edge
    if (y + ACTION_WINDOW_HEIGHT > workArea.y + workArea.height) {
      y = cursor.y - ACTION_WINDOW_HEIGHT - 10;
    }

    // Ensure not exceeding left/top edges
    x = Math.max(workArea.x + 10, x);
    y = Math.max(workArea.y + 10, y);

    return { x, y };
  }

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
        this.showActionWindow(data);
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

  private getRendererEntryUrl(entry: string): string | null {
    const baseUrl = process.env.ELECTRON_RENDERER_URL || process.env.VITE_DEV_SERVER_URL;
    if (!baseUrl) return null;
    return `${baseUrl.replace(/\/$/, '')}/${entry}`;
  }

  private async loadWindowContent(window: BrowserWindow, entry: string): Promise<void> {
    const devUrl = this.getRendererEntryUrl(entry);
    try {
      if (devUrl) {
        logger.info(`[SelectionService] Loading window page (dev): ${devUrl}`);
        await window.loadURL(devUrl);
        return;
      }
      const filePath = join(__dirname, '../renderer', entry);
      logger.info(`[SelectionService] Loading window page (file): ${filePath}`);
      await window.loadFile(filePath);
    } catch (error) {
      logger.error(
        `[SelectionService] Failed to load window page: ${entry} -> ${this.formatError(error)}`
      );
      if (devUrl) {
        const filePath = join(__dirname, '../renderer', entry);
        try {
          logger.warn(`[SelectionService] Attempting loadFile fallback: ${filePath}`);
          await window.loadFile(filePath);
          return;
        } catch (fallbackError) {
          logger.error(
            `[SelectionService] Fallback load failed: ${entry} -> ${this.formatError(fallbackError)}`
          );
        }
      }
      throw error;
    }
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

    await this.ensureToolbarWindow();
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
    this.showToolbarWindow(data);
  };

  /**
   * Gets cached selection data.
   */
  getCachedSelection(): SelectionCaptureData | null {
    return this.cachedSelection;
  }
}
