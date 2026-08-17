/**
 * @file SelectionTab.tsx - Selection Assistant Settings Tab
 * @description Configures the selection assistant's enabled state and keyboard shortcuts
 */

import { ConfigKeys } from '@shared/types/config-keys';
import type { SelectionConfigDTO, SelectionLifecycleResultDTO } from '@shared/ipc/types';
import { Hand, Keyboard, Settings2, ShieldAlert } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { useTranslation } from '../../locales';
import { SelectionSetupDialog } from '../onboarding/SelectionSetupDialog';
import {
  SectionTitle,
  SettingCard,
  SettingItem,
  Toggle,
  inputMonoClassName,
  selectClassName,
} from './SettingsUI';

// Allowed shortcut grammar. Modifier chunks match Electron's documented
// globalShortcut modifiers (Control is the canonical spelling). `Meta`
// IS accepted by Electron's parser (it maps to Cmd on macOS, Win on
// Windows/Linux — same physical key as `Cmd`/`Super`) but is deliberately
// kept out here to steer users toward the platform-neutral `Cmd` /
// `Super` spellings; canonicalizeModifier folds Meta into the same
// uniqueness group so `Ctrl+Meta+Cmd+K` still rejects. The key
// slot is a whitelist of the accelerator vocabulary Electron accepts —
// crucially, punctuation is passed as its literal character (`-`, `=`,
// `,`, `.`, `/`, `\`, `;`, `'`, `[`, `]`) not the DomCode name (`Minus`
// etc.), which caused Alt+Minus to pass renderer validation and then
// throw main-side. Regex is compiled with `i` because Electron lowercases
// tokens before parsing — `ctrl+shift+k` (a common casing) was previously
// rejected by the renderer while main registered it fine.
const SHORTCUT_MODIFIERS = [
  'CommandOrControl',
  'CmdOrCtrl',
  'Control',
  'Ctrl',
  'Alt',
  'AltGr',
  'Shift',
  'Cmd',
  'Command',
  'Option',
  'Super',
] as const;
// `_PATTERN` (not `_ALT`) — the original suffix collided with the `Alt`
// modifier key name and read as "alt suffix". This constant is the regex
// alternation of all modifier names.
const SHORTCUT_MODIFIER_PATTERN = SHORTCUT_MODIFIERS.join('|');
// Letters, digits, function keys F1-F24, arrow keys, named/misc keys,
// numpad keys, and literal punctuation characters — matches Electron's
// globalShortcut accelerator vocabulary. Punctuation is `.,/\\;'[]` etc.
// spelled literally; the DomCode names like `Minus`/`Equal` are NOT
// accepted by Electron and would defer failure to main-side registration.
const SHORTCUT_KEY_PATTERN =
  '[A-Za-z0-9]' +
  '|F(?:[1-9]|1[0-9]|2[0-4])' +
  '|Space|Tab|Backspace|Delete|Insert|Enter|Return|Esc(?:ape)?' +
  '|Home|End|PageUp|PageDown|Up|Down|Left|Right' +
  '|Plus|Capslock|Numlock|Scrolllock|PrintScreen' +
  '|num[0-9]|numdec|numadd|numsub|nummult|numdiv' +
  // Literal punctuation Electron accepts as the key slot. Escaped for
  // regex where needed (\\ \\] \\/ etc.). Backtick and backslash chars
  // included so the class matches them literally.
  "|[-=,./\\\\;'\\[\\]`]";
const SHORTCUT_REGEX = new RegExp(
  `^(${SHORTCUT_MODIFIER_PATTERN})(\\+(${SHORTCUT_MODIFIER_PATTERN}))*\\+(${SHORTCUT_KEY_PATTERN})$`,
  'i'
);

/**
 * Canonicalize a modifier chunk to a single lower-case form so semantic
 * aliases collide during the uniqueness check. Without this,
 * `Ctrl+CmdOrCtrl+K` / `Control+Ctrl+K` slip past renderer validation and
 * fail main-side with the misleading `shortcut_conflict` code.
 */
function canonicalizeModifier(chunk: string): string {
  const lower = chunk.toLowerCase();
  if (['ctrl', 'control', 'cmdorctrl', 'commandorcontrol'].includes(lower)) return 'ctrl';
  // Cmd / Command / Super all map to the same physical key in Electron's
  // accelerator model (Cmd on macOS, Win on Windows/Linux). Grouping them
  // catches `Ctrl+Super+Cmd+K` etc., which would otherwise slip past the
  // uniqueness check with 3 distinct chunks.
  //
  // `Meta` is not listed: it's absent from SHORTCUT_MODIFIERS, so the
  // regex rejects any Meta-containing accelerator before this canonicalize
  // step ever runs. Adding 'meta' here would be a dead branch.
  if (['cmd', 'command', 'super'].includes(lower)) return 'cmd';
  if (['alt', 'option'].includes(lower)) return 'alt';
  return lower;
}

/** Runtime validation: shape check + no duplicate (canonicalized) modifiers. */
function isValidShortcut(shortcut: string): boolean {
  if (!SHORTCUT_REGEX.test(shortcut)) return false;
  const chunks = shortcut.split('+');
  const modifiers = chunks.slice(0, -1).map(canonicalizeModifier);
  return new Set(modifiers).size === modifiers.length;
}

/**
 * Selection Assistant Settings Tab Component
 */
export const SelectionTab: React.FC = () => {
  const { t } = useTranslation();
  const shortcutInputId = 'selection-shortcut-input';
  const shortcutDescriptionId = 'selection-shortcut-description';
  // Separate ID for the inline error <p> so it can be added to the
  // shortcut input's `aria-describedby` when present; without this, screen
  // readers never announce the validation error.
  const shortcutErrorId = 'selection-shortcut-error';
  const triggerModeSelectId = 'selection-trigger-mode-select';
  const triggerModeDescriptionId = 'selection-trigger-mode-description';
  const [config, setConfig] = useState<SelectionConfigDTO>({
    enabled: false,
    triggerMode: 'shortcut',
    shortcutKey: 'Alt+D',
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [hasConsent, setHasConsent] = useState<boolean>(false);
  const [consentDialogOpen, setConsentDialogOpen] = useState<boolean>(false);
  // Distinguishes "consent dialog opened as part of the enable-toggle
  // flow" vs. "consent dialog opened from the Review Consent link". The
  // former should chain into `applyEnabled(true)` on confirm; the latter
  // must NOT — it would enable the feature without the user having
  // explicitly toggled it.
  const [pendingEnable, setPendingEnable] = useState<boolean>(false);
  const [shortcutInputError, setShortcutInputError] = useState<string | null>(null);
  // Remember the last shortcut that actually passed validation, so an
  // invalid onBlur can revert the input without waiting for the next
  // successful save round-trip. Initialized to '' rather than a hardcoded
  // default so a loadConfig failure doesn't silently rewrite the user's
  // real shortcut to 'Alt+D' on the next invalid input.
  const lastValidShortcutRef = useRef<string>('');
  const platform = api.app.getPlatform();
  const hookSupported = platform === 'win32' || platform === 'darwin';

  useEffect(() => {
    const loadConfig = async () => {
      setIsLoading(true);
      try {
        const [cfg, consent] = await Promise.all([
          api.selection.getConfig(),
          api.config.get<boolean>(ConfigKeys.SelectionCaptureConsent),
        ]);
        if (cfg) {
          setConfig(cfg);
          // Only seed the revert anchor if the persisted value clears the
          // current grammar — a legacy or hand-edited shortcut that fails
          // isValidShortcut must not become the "known-valid" fallback,
          // or the first invalid blur would revert into another invalid
          // string with aria-invalid stuck on.
          if (isValidShortcut(cfg.shortcutKey)) {
            lastValidShortcutRef.current = cfg.shortcutKey;
          }
        }
        setHasConsent(Boolean(consent));
      } catch (err) {
        console.error('[SelectionTab] Failed to load config:', err);
        setError(t('selectionSettings.loadConfigFailed'));
      } finally {
        setIsLoading(false);
      }
    };

    loadConfig();
  }, [t]);

  // aria-invalid is keyed off `shortcutInputError` (set on blur), not a
  // live isValidShortcut recomputation. Every intermediate keystroke of a
  // multi-char key (`S`, `Sp`, `Spa`…) would otherwise be marked invalid
  // to screen readers before the actual validation ran.

  // Derive from the wire DTO so a new lifecycle code added on the shared
  // side lights up here as an unhandled variant in handleLifecycleError.
  // Manually mirroring the union let it silently drift on prior rounds.
  type LifecycleCode = SelectionLifecycleResultDTO['code'];

  // Single mapping of SelectionLifecycleResultDTO → UI message + side effect.
  // Both updateConfig and applyEnabled surface identical failure modes, so
  // the branching lived twice; consolidating keeps a new error code (or a
  // reworded copy) in exactly one place. Opening the consent dialog is a
  // side effect; setting pendingEnable is up to the caller (see applyEnabled).
  /**
   * Best-effort re-fetch of the persisted config from main, used after a
   * lifecycle failure so the UI toggle/shortcut input matches the service
   * state (main-side may have rolled back or force-disabled). Isolated
   * try/catch so an IPC transport error here does not hijack the outer
   * catch and lose the precise lifecycle `code`. Also re-seeds the
   * revert anchor when the fresh value passes validation.
   */
  const resyncConfig = useCallback(async (): Promise<void> => {
    try {
      const fresh = await api.selection.getConfig();
      if (fresh) {
        setConfig(fresh);
        if (isValidShortcut(fresh.shortcutKey)) {
          lastValidShortcutRef.current = fresh.shortcutKey;
        }
      }
    } catch {
      // Best-effort UI re-sync; keep going.
    }
  }, []);

  const handleLifecycleError = useCallback(
    (code: LifecycleCode, error: string | undefined, shortcut: string) => {
      // Clear the transient "Settings saved" banner up-front: applyEnabled
      // can produce updateConfig-success → setEnabled-failure, and both
      // banners would otherwise render simultaneously until the (untracked)
      // 2s success timer fires and confusingly clears itself.
      setSuccess(null);
      if (code === 'consent_required') {
        setError(t('selectionSettings.consentRequired'));
        setConsentDialogOpen(true);
        return;
      }
      if (code === 'shortcut_conflict') {
        setError(t('selectionSettings.shortcutConflict', { shortcut }));
        return;
      }
      if (code === 'hook_unavailable') {
        // Main-side emits a developer-facing English string for this code
        // ("Selection hook failed to start …"). Map to the localized banner
        // so a zh-CN user doesn't see raw English mid-flow.
        setError(t('selectionSettings.hookUnavailableBanner'));
        return;
      }
      setError(error || t('selectionSettings.saveFailed'));
    },
    [t]
  );

  const updateConfig = useCallback(
    async (updates: Partial<SelectionConfigDTO>) => {
      setIsSaving(true);
      setError(null);
      setSuccess(null);

      try {
        const result = await api.selection.setConfig(updates);
        if (result.success) {
          setConfig((prev) => ({ ...prev, ...updates }));
          setSuccess(t('selectionSettings.settingsSaved'));
          setTimeout(() => setSuccess(null), 2000);
          return result;
        }
        // The service already rolled its persisted config back on failure;
        // re-sync so the visible input/toggle matches. See resyncConfig
        // for the isolated try/catch rationale.
        await resyncConfig();
        handleLifecycleError(result.code, result.error, updates.shortcutKey ?? config.shortcutKey);
        return result;
      } catch (err) {
        console.error('[SelectionTab] Failed to update config:', err);
        setError(`${t('selectionSettings.saveFailed')}: ${String(err)}`);
        return { success: false as const };
      } finally {
        setIsSaving(false);
      }
    },
    [t, config.shortcutKey, handleLifecycleError, resyncConfig]
  );

  const applyEnabled = useCallback(
    async (enabled: boolean) => {
      // Pre-flag pendingEnable whenever we're trying to enable, so a
      // consent_required failure from EITHER updateConfig or setEnabled
      // routes the eventual dialog confirmation back to applyEnabled(true).
      // Without this, a stale hasConsent (revoked between load and toggle)
      // would open the consent dialog with pendingEnable=false, and the
      // user's grant would silently fail to enable the service.
      if (enabled) setPendingEnable(true);

      const cfgResult = await updateConfig({ enabled });
      if (!cfgResult?.success) {
        // updateConfig already surfaced the error via handleLifecycleError.
        // Skip the redundant setEnabled call that would trigger duplicate
        // error toasts / dialog opens with no new information.
        if (cfgResult?.code !== 'consent_required') setPendingEnable(false);
        return;
      }

      try {
        const result = await api.selection.setEnabled(enabled);
        if (!result?.success) {
          // Mirror the updateConfig failure branch: main-side may have
          // force-disabled + persisted on internal rollback (e.g. doStart
          // failed after consent was revoked externally). Re-sync so the
          // toggle doesn't linger optimistically ON while the service and
          // disk agree it's OFF.
          await resyncConfig();
          handleLifecycleError(result?.code, result?.error, config.shortcutKey);
          if (result?.code !== 'consent_required') setPendingEnable(false);
        } else {
          setPendingEnable(false);
        }
      } catch (err) {
        console.error('[SelectionTab] Failed to toggle enabled state:', err);
        setError(`${t('selectionSettings.enableDisableFailed')}: ${String(err)}`);
        setPendingEnable(false);
      }
    },
    [updateConfig, t, config.shortcutKey, handleLifecycleError, resyncConfig]
  );

  const handleToggleEnabled = useCallback(
    async (enabled: boolean) => {
      // Consent gate: renderer refuses to flip enabled=true without consent
      // so the main-side check never has to reject a UI action after the fact.
      if (enabled && !hasConsent) {
        setPendingEnable(true);
        setConsentDialogOpen(true);
        return;
      }
      await applyEnabled(enabled);
    },
    [hasConsent, applyEnabled]
  );

  const handleShortcutChange = useCallback(
    async (shortcutKey: string) => {
      const trimmed = shortcutKey.trim();
      if (!isValidShortcut(trimmed)) {
        setShortcutInputError(t('selectionSettings.shortcutInvalid'));
        // Revert the visible input to the last known-valid value so the
        // user is not left staring at a rejected string across other
        // interactions. Skip the revert entirely when we have no anchor
        // yet (initial loadConfig failed) — writing '' into the input
        // would be worse than leaving the invalid string visible.
        if (lastValidShortcutRef.current) {
          setConfig((prev) => ({ ...prev, shortcutKey: lastValidShortcutRef.current }));
          // The visible value is now valid again; leaving shortcutInputError
          // set would flag aria-invalid on a valid string and have the
          // role="alert" paragraph declare the field wrong. Clear it and
          // let the top-of-tab error banner (from the failed save, or a
          // rejected onBlur) carry the messaging instead.
          setShortcutInputError(null);
        }
        return;
      }
      setShortcutInputError(null);
      // Short-circuit when nothing actually changed (user focused and
      // blurred, or an invalid onBlur just reverted the value back to the
      // known-valid anchor). Skipping avoids a redundant IPC round-trip,
      // a spurious "Settings saved" toast, and re-registering the same
      // accelerator main-side.
      if (trimmed === lastValidShortcutRef.current) return;
      // Only promote to "last valid" AFTER the service accepts the change.
      // Setting the ref up-front would corrupt the revert target when the
      // main-side rejects with shortcut_conflict (updateConfig rolls the
      // persisted shortcut back but the ref would still hold the failing
      // combo, sending the NEXT invalid input to the broken value).
      const result = await updateConfig({ shortcutKey: trimmed });
      if (result?.success) {
        lastValidShortcutRef.current = trimmed;
      }
    },
    [updateConfig, t]
  );

  const handleTriggerModeChange = useCallback(
    async (triggerMode: SelectionConfigDTO['triggerMode']) => {
      await updateConfig({ triggerMode });
    },
    [updateConfig]
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-[var(--color-text-muted)]">{t('selectionSettings.loading')}</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 rounded-lg bg-[var(--color-accent-muted)]">
          <Hand className="w-5 h-5 text-[var(--color-accent)]" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">
            {t('selectionSettings.title')}
          </h2>
          <p className="text-sm text-[var(--color-text-muted)]">
            {t('selectionSettings.subtitle')}
          </p>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
          {error}
        </div>
      )}
      {success && (
        <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/30 text-green-400 text-sm">
          {success}
        </div>
      )}
      {config.enabled && config.triggerMode === 'shortcut' && !hookSupported && (
        <div className="p-3 rounded-lg bg-[var(--color-warning-muted)] border border-[var(--color-warning)]/40 text-[var(--color-warning)] text-xs flex items-start gap-2">
          <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{t('selectionSettings.hookUnavailableBanner')}</span>
        </div>
      )}

      <SectionTitle>{t('selectionSettings.basicSettings')}</SectionTitle>

      <SettingCard>
        <Toggle
          label={t('selectionSettings.enableSelection')}
          desc={t('selectionSettings.enableSelectionDesc')}
          checked={config.enabled}
          onChange={handleToggleEnabled}
          disabled={isSaving}
        />
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setConsentDialogOpen(true)}
            className="cursor-pointer text-[11px] text-[var(--color-text-muted)] underline-offset-2 hover:text-[var(--color-text-primary)] hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
          >
            {t('selectionSettings.reviewConsent')}
          </button>
        </div>
      </SettingCard>

      <SettingCard
        title={t('selectionSettings.triggerShortcut')}
        description={
          <span id={shortcutDescriptionId}>{t('selectionSettings.triggerShortcutDesc')}</span>
        }
      >
        <SettingItem label={t('selectionSettings.shortcut')}>
          <div className="flex items-center gap-3">
            <label htmlFor={shortcutInputId} className="sr-only">
              {t('selectionSettings.shortcut')}
            </label>
            <Keyboard className="w-4 h-4 text-[var(--color-text-muted)]" aria-hidden="true" />
            <input
              id={shortcutInputId}
              aria-describedby={
                shortcutInputError
                  ? `${shortcutDescriptionId} ${shortcutErrorId}`
                  : shortcutDescriptionId
              }
              type="text"
              className={inputMonoClassName}
              value={config.shortcutKey}
              aria-invalid={Boolean(shortcutInputError)}
              onChange={(e) => {
                setConfig((prev) => ({ ...prev, shortcutKey: e.target.value }));
                // Clear the stale error the moment the user starts editing
                // — otherwise a rejected combo keeps its red banner up
                // through several keystrokes until the next blur.
                if (shortcutInputError) setShortcutInputError(null);
              }}
              onBlur={() => handleShortcutChange(config.shortcutKey)}
              placeholder={t('selectionSettings.shortcutPlaceholder')}
              disabled={isSaving || !config.enabled}
            />
          </div>
          {shortcutInputError && (
            <p id={shortcutErrorId} role="alert" className="mt-1 text-xs text-[var(--color-error)]">
              {shortcutInputError}
            </p>
          )}
        </SettingItem>

        <div className="mt-3 p-3 rounded-lg bg-[var(--color-bg-tertiary)] text-xs text-[var(--color-text-muted)]">
          <p className="font-medium mb-1">{t('selectionSettings.supportedModifiers')}</p>
          <ul className="list-disc list-inside space-y-0.5">
            <li>Ctrl / Command (macOS)</li>
            <li>Alt / Option (macOS)</li>
            <li>Shift</li>
          </ul>
          <p className="mt-2 text-[var(--color-text-secondary)]">
            {t('selectionSettings.modifierExample')}
          </p>
        </div>
      </SettingCard>

      <SettingCard
        title={t('selectionSettings.triggerMode')}
        description={
          <span id={triggerModeDescriptionId}>{t('selectionSettings.triggerModeDesc')}</span>
        }
      >
        <div className="flex items-center gap-3">
          <label htmlFor={triggerModeSelectId} className="sr-only">
            {t('selectionSettings.triggerMode')}
          </label>
          <Settings2 className="w-4 h-4 text-[var(--color-text-muted)]" aria-hidden="true" />
          <select
            id={triggerModeSelectId}
            aria-describedby={triggerModeDescriptionId}
            className={selectClassName}
            value={config.triggerMode}
            onChange={(e) =>
              handleTriggerModeChange(e.target.value as SelectionConfigDTO['triggerMode'])
            }
            disabled={isSaving || !config.enabled}
          >
            <option value="shortcut">{t('selectionSettings.shortcutTrigger')}</option>
            <option value="hook" disabled={!hookSupported}>
              {t('selectionSettings.globalSelectionPopup')}
            </option>
          </select>
        </div>
        {!hookSupported && (
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">
            {t('selectionSettings.platformNotSupported')}
          </p>
        )}
      </SettingCard>

      <SectionTitle>{t('selectionSettings.instructions')}</SectionTitle>

      <SettingCard>
        <div className="space-y-3 text-sm text-[var(--color-text-secondary)]">
          <div className="flex items-start gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-[var(--color-accent-muted)] text-[var(--color-accent)] flex items-center justify-center text-xs font-medium">
              1
            </span>
            <p>{t('selectionSettings.step1')}</p>
          </div>
          <div className="flex items-start gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-[var(--color-accent-muted)] text-[var(--color-accent)] flex items-center justify-center text-xs font-medium">
              2
            </span>
            <p>
              {t('selectionSettings.step2')}{' '}
              <kbd className="px-1.5 py-0.5 rounded bg-[var(--color-bg-tertiary)] text-xs font-mono">
                {config.shortcutKey}
              </kbd>{' '}
              {t('selectionSettings.step2Suffix')}
            </p>
          </div>
          <div className="flex items-start gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-[var(--color-accent-muted)] text-[var(--color-accent)] flex items-center justify-center text-xs font-medium">
              3
            </span>
            <p>{t('selectionSettings.step3')}</p>
          </div>
        </div>
      </SettingCard>

      <SelectionSetupDialog
        open={consentDialogOpen}
        hookAvailable={hookSupported}
        onClose={() => {
          setConsentDialogOpen(false);
          setPendingEnable(false);
        }}
        onConfirmed={async () => {
          setHasConsent(true);
          // Only continue into the enable flow if the dialog was opened
          // from the enable toggle. When it was opened from the "Review
          // consent" link, the user just wants to re-read the notice, not
          // flip the service on. Await so the SelectionSetupDialog's
          // try/catch actually sees any async failure from applyEnabled
          // while the dialog is still on screen.
          if (pendingEnable) {
            await applyEnabled(true);
          }
        }}
      />
    </div>
  );
};

export default SelectionTab;
