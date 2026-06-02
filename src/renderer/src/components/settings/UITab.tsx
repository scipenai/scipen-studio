/**
 * @file UITab.tsx - UI Settings Tab
 * @description Configures UI preferences such as theme, language, animation effects, etc.
 */

import type React from 'react';
import { useCallback } from 'react';
import { type LocaleKey, SUPPORTED_LOCALES, setLocale, useTranslation } from '../../locales';
import { getSettingsService } from '../../services/core/ServiceRegistry';
import { useSettings } from '../../services/core/hooks';
import { SectionTitle, SettingItem, selectClassName } from './SettingsUI';

/** 聊天字号离散档(px)。值写入 ui.chatFontSize,驱动 --chat-font-size。 */
const CHAT_FONT_OPTIONS = [
  { size: 13, labelKey: 'settings.chatFontSmall' },
  { size: 14, labelKey: 'settings.chatFontStandard' },
  { size: 16, labelKey: 'settings.chatFontLarge' },
  { size: 18, labelKey: 'settings.chatFontXLarge' },
] as const;

export const UITab: React.FC = () => {
  const settings = useSettings();
  const settingsService = getSettingsService();
  const { t, locale } = useTranslation();

  // Handle language change
  const handleLanguageChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const newLocale = e.target.value as LocaleKey;
      // Update language immediately (triggers UI re-render)
      setLocale(newLocale);
      // Also save to settings
      settingsService.updateUI({ language: newLocale });
    },
    [settingsService]
  );

  return (
    <>
      <SectionTitle>{t('settings.appearance')}</SectionTitle>

      <SettingItem label={t('settings.theme')}>
        <select
          value={settings.ui.theme}
          onChange={(e) =>
            settingsService.updateUI({ theme: e.target.value as 'dark' | 'light' | 'system' })
          }
          className={selectClassName}
        >
          <option value="dark">{t('settings.themeDark')}</option>
          <option value="light">{t('settings.themeLight')}</option>
          <option value="system">{t('settings.themeSystem')}</option>
        </select>
      </SettingItem>

      <SettingItem label={t('settings.language')}>
        <select value={locale} onChange={handleLanguageChange} className={selectClassName}>
          {SUPPORTED_LOCALES.map((loc) => (
            <option key={loc.key} value={loc.key}>
              {loc.nativeName}
            </option>
          ))}
        </select>
      </SettingItem>

      <SettingItem label={t('settings.chatFontSize')}>
        <div className="flex gap-1.5">
          {CHAT_FONT_OPTIONS.map((opt) => {
            const active = settings.ui.chatFontSize === opt.size;
            return (
              <button
                key={opt.size}
                type="button"
                onClick={() => settingsService.updateUI({ chatFontSize: opt.size })}
                className={`flex-1 rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent-muted)] text-[var(--color-accent)]'
                    : 'border-[var(--color-border)] bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]'
                }`}
              >
                {t(opt.labelKey)}
              </button>
            );
          })}
        </div>
      </SettingItem>
    </>
  );
};
