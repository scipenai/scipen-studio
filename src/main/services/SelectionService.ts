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
  SelectionLifecycleResult,
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
  // Remember the accelerator string that is CURRENTLY bound with the OS.
  // Using this as the source of truth for unregister (instead of reading
  // `this.config.shortcutKey` at unregister time) avoids the class of bugs
  // where a mutation to `this.config` mid-reconfigure causes the OLD
  // accelerator to leak — `unregister(this.config.shortcutKey)` would
  // silently target the new (never-registered) key.
  private registeredShortcut: string | null = null;
  private hookRunning = false;
  private hookListenersBound = false;
  private selectionHook: SelectionHookInstance | null = null;
  /**
   * Serializes async lifecycle mutations (start / stop / updateConfig /
   * setEnabled). Each op waits for the previous chain link before running,
   * so overlapping IPC calls — e.g. boot autostart racing a user toggle,
   * or a rapid mode-flip landing during an in-flight rollback — cannot
   * interleave `previousConfig` snapshots, `registeredShortcut` state, and
   * disk-persist writes into inconsistency.
   */
  private lifecycleChain: Promise<unknown> = Promise.resolve();

  private readonly _onTextCaptured = new Emitter<SelectionCaptureData>();
  readonly onTextCaptured = this._onTextCaptured.event;

  constructor() {
    logger.info('[SelectionService] Instance created');

    // Load persisted config from ConfigManager
    this.loadConfig();
    // Do NOT eagerly `new SelectionHook()` here. startHookMode() owns the
    // single instantiation path so lifecycle and error handling live in one
    // place — the redundant constructor + startHookMode instantiations
    // previously masked which path actually created the hook.
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

  /**
   * Serialize an async lifecycle op so overlapping calls run to completion
   * one at a time. Errors on the chain are swallowed for scheduling
   * purposes (the caller still receives the rejection), otherwise a single
   * failure would poison every future enqueue.
   */
  private enqueueLifecycle<T>(op: () => Promise<T>): Promise<T> {
    const run = this.lifecycleChain.then(op, op);
    this.lifecycleChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * Take the service down and persist enabled=false so on-disk config
   * agrees with the runtime state. Three lifecycle-failure sites converged
   * on the same 3-line snippet — extracting keeps the "isRunning/isEnabled
   * must not lie" invariant in one place.
   */
  private forceDisableAndPersist(): void {
    this.stop();
    this.config.enabled = false;
    this.saveConfig();
  }

  start(): Promise<SelectionLifecycleResult> {
    return this.enqueueLifecycle(() => this.doStart());
  }

  private async doStart(): Promise<SelectionLifecycleResult> {
    if (this.started) {
      logger.warn('[SelectionService] Service already running');
      return { success: true };
    }

    // Gate: user must explicitly consent to cross-app selection reads.
    // Renderer surfaces this via the SelectionSetupDialog, but the main
    // process re-checks so the service refuses to run even if an old
    // config file has enabled=true without consent (upgrade path).
    if (!configManager.get<boolean>(ConfigKeys.SelectionCaptureConsent)) {
      logger.warn('[SelectionService] Start blocked: capture consent not granted');
      return {
        success: false,
        code: 'consent_required',
        error: 'Selection capture consent has not been granted',
      };
    }

    try {
      if (this.config.triggerMode === 'hook') {
        const started = await this.startHookMode();
        if (!started) {
          return {
            success: false,
            code: 'hook_unavailable',
            error: 'Selection hook failed to start (platform / permission)',
          };
        }
      } else {
        const shortcutOk = this.registerShortcut();
        if (!shortcutOk) {
          return {
            success: false,
            code: 'shortcut_conflict',
            error: `Global shortcut "${this.config.shortcutKey}" is unavailable (likely bound by another app)`,
          };
        }
        // In shortcut mode, hook is only used for hook.getCurrentSelection().
        // Silent mode = never trigger the macOS accessibility system prompt just
        // because the user picked shortcut mode; a failing hook is a soft fallback,
        // not an install-time authorization request.
        const hookStarted = await this.startHookMode({ silentPermission: true });
        if (!hookStarted) {
          logger.warn(
            '[SelectionService] Hook start failed in shortcut mode; clipboard fallback expects pre-copied selection'
          );
        }
      }

      this.started = true;
      logger.info('[SelectionService] Service started');
      return { success: true };
    } catch (error) {
      this.cleanupAfterFailedStart();
      const msg = this.formatError(error);
      logger.error(`[SelectionService] Failed to start: ${msg}`);
      return { success: false, code: 'unknown', error: msg };
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

  setEnabled(enabled: boolean): Promise<SelectionLifecycleResult> {
    return this.enqueueLifecycle(() => this.doSetEnabled(enabled));
  }

  private async doSetEnabled(enabled: boolean): Promise<SelectionLifecycleResult> {
    this.config.enabled = enabled;
    this.saveConfig();
    logger.info(`[SelectionService] Enabled state: ${enabled}`);

    if (enabled && !this.started) {
      // Call doStart directly, NOT start(): we're already inside a
      // lifecycle-chain slot, and a nested enqueue would deadlock.
      const result = await this.doStart();
      if (!result.success) {
        // Roll back the persisted enabled flag so the UI does not present
        // "enabled" while the service is not actually running.
        // stop() inside the helper is a harmless no-op here — this branch
        // is entered under `!this.started` and doStart's failure cleanup
        // already ran cleanupAfterFailedStart.
        this.forceDisableAndPersist();
      }
      return result;
    }

    if (!enabled && this.started) {
      this.stop();
    }

    return { success: true };
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  getConfig(): SelectionConfig {
    return { ...this.config };
  }

  updateConfig(config: Partial<SelectionConfig>): Promise<SelectionLifecycleResult> {
    return this.enqueueLifecycle(() => this.doUpdateConfig(config));
  }

  private async doUpdateConfig(
    config: Partial<SelectionConfig>
  ): Promise<SelectionLifecycleResult> {
    const previousConfig: SelectionConfig = { ...this.config };
    const oldShortcut = previousConfig.shortcutKey;
    const oldTriggerMode = previousConfig.triggerMode;
    this.config = { ...this.config, ...config };

    // Persist configuration
    this.saveConfig();

    // Mirror doSetEnabled: if a caller flips enabled=false through
    // updateConfig we must stop the running service too. Renderer's
    // applyEnabled(false) calls updateConfig({enabled:false}) BEFORE
    // setEnabled(false); leaving the service running here would keep the
    // OS shortcut / hook alive between the two IPC calls (or worse, if
    // the follow-up setEnabled never lands) while isEnabled() reports
    // false — the exact isRunning/isEnabled divergence forceDisableAndPersist
    // claims to prevent.
    if (config.enabled === false && this.started) {
      this.stop();
    }

    const modeChanged = Boolean(config.triggerMode && config.triggerMode !== oldTriggerMode);
    const shortcutChanged = Boolean(config.shortcutKey && config.shortcutKey !== oldShortcut);

    // On a failed reconfigure we MUST roll the persisted config back so
    // the UI's "settings saved" toast does not lie: leaving the new
    // shortcut / mode on disk would silently disable the global shortcut
    // until the user reboots.
    const rollback = (): void => {
      this.config = { ...previousConfig };
      this.saveConfig();
    };

    // A mode flip always requires a full stop/start, which by itself
    // re-registers the (possibly new) shortcut. Doing a separate
    // re-register on top would restart the shortcut twice for no reason;
    // collapse into a single restart when both fields moved.
    if (modeChanged && this.started) {
      this.stop();
      if (this.config.enabled) {
        // doStart (not start): we're already inside a lifecycle slot.
        const startResult = await this.doStart();
        if (!startResult.success) {
          rollback();
          // Best-effort: bring the previous mode back so the user is not
          // left with a running-but-broken service after a mode swap.
          // If the fallback ALSO fails (e.g. previous shortcut got grabbed
          // in the meantime), we still return the original failure but
          // force-disable so the persisted "enabled" flag matches runtime.
          if (previousConfig.enabled) {
            const fallbackResult = await this.doStart();
            if (!fallbackResult.success) {
              logger.error(
                `[SelectionService] Rollback restart with previous config also failed (${fallbackResult.code ?? 'unknown'}): ${fallbackResult.error ?? ''}`
              );
              this.forceDisableAndPersist();
            }
          }
          return startResult;
        }
      }
    } else if (shortcutChanged && this.started && this.config.triggerMode === 'shortcut') {
      // registerShortcut() early-returns true when `registeredShortcut`
      // is already set, so we MUST unregister before attempting the new
      // registration — otherwise the second call becomes a silent no-op
      // and both the old and new accelerators appear to succeed while
      // only the old one is actually bound.
      this.unregisterShortcut();
      const ok = this.registerShortcut();
      if (!ok) {
        // Restore the old shortcut so the global hotkey continues to
        // work — the new one is unavailable (usually taken by another app).
        rollback();
        const restored = this.registerShortcut();
        if (!restored) {
          // Both new and old accelerators are unavailable now. Leaving
          // `started=true / enabled=true` while `registeredShortcut=null`
          // would let isRunning()/isEnabled() lie about the runtime.
          logger.error(
            `[SelectionService] Failed to restore previous shortcut "${previousConfig.shortcutKey}" after rollback — stopping service to keep state honest`
          );
          this.forceDisableAndPersist();
        }
        return {
          success: false,
          code: 'shortcut_conflict',
          error: `Global shortcut "${config.shortcutKey}" is unavailable (likely bound by another app)`,
        };
      }
    }

    // Try starting if enabled but not running (recovery from failed start)
    if (this.config.enabled && !this.started) {
      const startResult = await this.doStart();
      if (!startResult.success) {
        rollback();
        return startResult;
      }
    }

    logger.info('[SelectionService] Config updated:', this.config);
    return { success: true };
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

      // Clipboard fallback path. We do NOT synthesize Ctrl+C (no robotjs /
      // nut-js dependency). The contract surfaced to the user via
      // SelectionSetupDialog + SelectionTab (locale key selectionSettings.*)
      // is "press Ctrl+C first, then the shortcut": the pre-copied text IS
      // the selection.
      //
      // Historically this branch also ran `clipboard.clear() +
      // simulateCopy() (no-op) + sleep + read` on the assumption a native
      // copy would replace what was cleared — but with simulateCopy empty,
      // the clear step guaranteed the read came back empty and destroyed
      // the user's pre-copied text. Just read the current clipboard.
      //
      // Logged at debug (not warn) because this is the documented, expected
      // path on Linux and on hook-load failure — every shortcut press would
      // otherwise flood the log with the same non-erroneous message.
      logger.debug(
        '[SelectionService] Hook unavailable; falling back to clipboard (requires pre-copied selection)'
      );
      const selectedText = clipboard.readText();

      if (!selectedText || selectedText.trim() === '') {
        logger.debug('[SelectionService] No text captured (clipboard empty)');
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

  private registerShortcut(): boolean {
    if (this.registeredShortcut !== null) {
      return true;
    }

    const shortcut = this.config.shortcutKey;
    const success = globalShortcut.register(shortcut, async () => {
      if (!this.config.enabled) {
        return;
      }

      logger.debug(`[SelectionService] Shortcut triggered: ${shortcut}`);

      const data = await this.captureCurrentSelection();
      if (data?.text.trim()) {
        this.sendCapturedTextToMainWindow(data);
      }
    });

    if (success) {
      this.registeredShortcut = shortcut;
      logger.info(`[SelectionService] Global shortcut registered: ${shortcut}`);
      return true;
    }
    // Common on macOS + Windows when another app (browser, IME, screenshot
    // tool) already owns the combo. Caller surfaces this to the user via
    // the SelectionLifecycleResult.
    logger.error(`[SelectionService] Failed to register shortcut: ${shortcut}`);
    return false;
  }

  private unregisterShortcut(): void {
    // Read from the "actually bound" state, NOT from `this.config`.
    // updateConfig() rewrites `this.config` early to persist the new
    // values; if we read the shortcut from config here after that write,
    // we would try to unbind a key the OS never registered, and the old
    // shortcut would remain live indefinitely.
    if (this.registeredShortcut === null) {
      return;
    }

    const shortcut = this.registeredShortcut;
    globalShortcut.unregister(shortcut);
    this.registeredShortcut = null;
    logger.info(`[SelectionService] Global shortcut unregistered: ${shortcut}`);
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

  private async startHookMode(opts?: { silentPermission?: boolean }): Promise<boolean> {
    logger.info('[SelectionService] Attempting to start Hook mode...');
    logger.info(
      `[SelectionService] isHookSupported: ${isHookSupported}, SelectionHook loaded: ${!!SelectionHook}, silentPermission: ${!!opts?.silentPermission}`
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

    // macOS accessibility permission check.
    // `isTrustedAccessibilityClient(true)` triggers the system permission
    // prompt. That is desirable when the user explicitly chose hook mode,
    // but NOT when we're auto-starting hook as a soft fallback under
    // shortcut mode — that would pop the scary permission dialog just for
    // switching modes. `silentPermission` gates the noisy path.
    if (isMac && !systemPreferences.isTrustedAccessibilityClient(false)) {
      if (opts?.silentPermission) {
        logger.warn('[SelectionService] Accessibility not granted; silent mode skips prompt');
        return false;
      }
      // Explicit hook mode — trigger the permission prompt so the user can grant.
      systemPreferences.isTrustedAccessibilityClient(true);
      logger.warn(
        '[SelectionService] Accessibility permission not granted, cannot enable selection hook'
      );
      return false;
    }

    if (!this.hookListenersBound) {
      logger.info('[SelectionService] Binding Hook event listeners...');
      this.selectionHook.on('error', this.handleHookError);
      this.selectionHook.on('text-selection', this.handleTextSelection);
      this.hookListenersBound = true;
      logger.info('[SelectionService] Hook event listeners bound');
    }

    logger.info('[SelectionService] Starting selection-hook...');
    const started = this.selectionHook.start({ debug: isDev });
    if (!started) {
      // .start() failed AFTER listeners were bound. If we return without
      // unbinding, the listeners stay attached to a never-started hook and
      // the next startHookMode() call would skip re-binding (thinking it
      // was already done) even if the hook instance was recreated. Unbind
      // now to keep hookListenersBound truthfully reflecting reality.
      this.unbindHookListeners();
      logger.error('[SelectionService] selection-hook failed to start');
      return false;
    }
    logger.info('[SelectionService] selection-hook started');

    this.hookRunning = true;
    logger.info('[SelectionService] Hook mode started successfully');
    return true;
  }

  private handleHookError = (error: { message?: string }): void => {
    logger.error('[SelectionService] selection-hook error:', error);
  };

  private unbindHookListeners(): void {
    if (!this.selectionHook || !this.hookListenersBound) return;
    try {
      // selection-hook exposes standard EventEmitter semantics; .off is
      // present when .on was used.
      this.selectionHook.off?.('error', this.handleHookError);
      this.selectionHook.off?.('text-selection', this.handleTextSelection);
    } catch (err) {
      logger.warn('[SelectionService] Failed to unbind hook listeners:', err);
    } finally {
      this.hookListenersBound = false;
    }
  }

  private stopHookMode(): void {
    // hook may have bound listeners even if it never .start()ed successfully
    // (shortcut-mode auto-hook that failed at .start(), for example). We
    // must unbind regardless of hookRunning to prevent orphaned closures
    // on the hook instance from surviving a full stop → start cycle.
    if (!this.selectionHook) {
      return;
    }

    if (this.hookRunning) {
      try {
        this.selectionHook.stop();
        if (typeof this.selectionHook.cleanup === 'function') {
          this.selectionHook.cleanup();
        }
      } catch (error) {
        logger.error('[SelectionService] Failed to stop selection-hook:', error);
      } finally {
        this.hookRunning = false;
      }
    }

    this.unbindHookListeners();
    // cleanup() releases the native instance's resources; reusing that
    // instance on the next stop → start cycle (routinely triggered now by
    // the updateConfig mode-flip rollback path) risks silent failure or
    // crash. Null the reference so the next startHookMode() rebuilds fresh.
    this.selectionHook = null;
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
    this.sendCapturedTextToMainWindow(data);
  };

  /**
   * Sends the full captured payload (text + sourceApp + cursorPosition) to the
   * currently focused window. Previous versions truncated to `{ text, capturedAt }`,
   * which discarded `sourceApp` even though the renderer's `SelectionCaptureDTO`
   * declares it — SelectionActionCard needs it to attribute the selection to its
   * origin app in the UI.
   */
  private sendCapturedTextToMainWindow(data: SelectionCaptureData): void {
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
        text: data.text,
        sourceApp: data.sourceApp,
        capturedAt: new Date(data.capturedAt).toISOString(),
        cursorPosition: data.cursorPosition,
      });
      if (targetWin.isMinimized()) targetWin.restore();
      targetWin.focus();
      logger.info(
        `[SelectionService] Sent captured text to window ${targetWin.id} (${data.text.length} chars, sourceApp=${data.sourceApp ?? 'unknown'})`
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
