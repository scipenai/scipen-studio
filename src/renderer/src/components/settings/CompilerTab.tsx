/**
 * @file CompilerTab.tsx - Compiler Settings Tab
 * @description Configures compiler settings for local projects
 */

import { useEffect, useState, type FC } from 'react';
import type { TypstCapabilities } from '../../../../../shared/ipc/compile-contract';
import { api } from '../../api';
import { useTranslation } from '../../locales';
import { createLogger } from '../../services/LogService';
import { getSettingsService } from '../../services/core/ServiceRegistry';
import { useProjectPath, useSettings } from '../../services/core/hooks';
import type { LaTeXEngine, TypstEngine } from '../../types';
import {
  SectionTitle,
  SettingCard,
  SettingItem,
  inputMonoClassName,
  selectClassName,
} from './SettingsUI';

const logger = createLogger('CompilerTab');

/**
 * Snapshot returned by the capability probe — `null` while in-flight,
 * never-changes-after-set once resolved. We deliberately re-probe on
 * every panel mount rather than caching at module scope: a user who
 * `cargo install tinymist`s mid-session expects the dropdown to update
 * after closing+reopening Settings, without having to restart the app.
 */
type TypstCapsState = TypstCapabilities | null;

export const CompilerTab: FC = () => {
  const { t } = useTranslation();
  const settings = useSettings();
  const settingsService = getSettingsService();
  const projectPath = useProjectPath();
  const [typstCaps, setTypstCaps] = useState<TypstCapsState>(null);

  useEffect(() => {
    let cancelled = false;
    api.compile
      .getTypstCapabilities()
      .then((caps) => {
        if (cancelled) return;
        setTypstCaps(caps);
        logger.info('Typst capabilities probed', caps);
      })
      .catch((error) => {
        if (cancelled) return;
        logger.warn('Typst capability probe failed', { error: String(error) });
        // Probe failure usually means a stale install (prod app.asar
        // predates the new IPC handler). Telling the user "everything is
        // available" would let them pick an engine that doesn't actually
        // exist and hit a confusing compile error. Faithfully report
        // "unknown" — UI then nudges the user to restart/reinstall.
        setTypstCaps({
          cli: {
            tinymist: { available: false, version: null },
            typst: { available: false, version: null },
          },
          wasm: { available: false, version: null },
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Build the dropdown options strictly from probed capabilities. The order
   * is fixed (Tinymist → Typst CLI → Typst) regardless of which are present
   * — keeping it stable means a user's muscle memory doesn't get reshuffled
   * by installing/uninstalling a CLI. Inline closure (not extracted) so we
   * can call `t` with its typed `TranslationKey` union directly.
   */
  const typstOptions: { value: TypstEngine; label: string }[] = [];
  if (typstCaps) {
    if (typstCaps.cli.tinymist.available) {
      typstOptions.push({ value: 'tinymist', label: t('compiler.tinymist') });
    }
    if (typstCaps.cli.typst.available) {
      typstOptions.push({ value: 'typst', label: t('compiler.typstCli') });
    }
    if (typstCaps.wasm.available) {
      typstOptions.push({ value: 'wasm-typst', label: t('compiler.typstWasm') });
    }
  }

  const currentTypstEngine = settings.compiler.typstEngine;
  const currentEngineUnavailable =
    typstOptions.length > 0 && !typstOptions.some((opt) => opt.value === currentTypstEngine);

  return (
    <>
      <SectionTitle>{t('compiler.title')}</SectionTitle>

      {projectPath && (
        <div className="mb-4 p-2 rounded-lg text-xs bg-[var(--color-accent-muted)] border border-[var(--color-accent)]/30 text-[var(--color-accent)]">
          {`💻 ${t('compiler.localProject')}`}
        </div>
      )}

      <SettingItem label={t('compiler.engine')} description={t('compiler.engineDesc')}>
        <select
          value={settings.compiler.engine}
          onChange={(e) =>
            settingsService.updateCompiler({ engine: e.target.value as LaTeXEngine })
          }
          className={selectClassName}
        >
          <option value="xelatex">{t('compiler.xelatexRecommended')}</option>
          <option value="lualatex">{t('compiler.lualatex')}</option>
          <option value="pdflatex">{t('compiler.pdflatex')}</option>
          <option value="tectonic">{t('compiler.tectonic')}</option>
          <option value="wasm-pdftex">{t('compiler.wasmPdftex')}</option>
          <option value="wasm-xetex">{t('compiler.wasmXetex')}</option>
          <option value="wasm-lualatex">{t('compiler.wasmLualatex')}</option>
        </select>
      </SettingItem>

      <SettingItem
        label={t('compiler.texliveEndpoint')}
        description={t('compiler.texliveEndpointDesc')}
      >
        <input
          type="text"
          value={settings.compiler.texliveEndpoint}
          onChange={(e) =>
            settingsService.updateCompiler({ texliveEndpoint: e.target.value.trim() })
          }
          placeholder="https://texlive2026.texlyre.org"
          className={inputMonoClassName}
        />
      </SettingItem>

      <SettingItem label={t('compiler.typstEngine')} description={t('compiler.typstEngineDesc')}>
        {typstCaps === null ? (
          <span className="text-xs text-[var(--color-text-muted)]">
            {t('compiler.typstProbing')}
          </span>
        ) : typstOptions.length === 0 ? (
          <span className="text-xs text-[var(--color-warning)]">
            {t('compiler.typstNoEngine')}
          </span>
        ) : (
          <select
            value={currentTypstEngine}
            onChange={(e) =>
              settingsService.updateCompiler({ typstEngine: e.target.value as TypstEngine })
            }
            className={selectClassName}
          >
            {typstOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        )}
      </SettingItem>

      {currentEngineUnavailable && (
        <div className="mb-4 p-2 rounded-lg text-xs bg-[var(--color-warning-muted)] border border-[var(--color-warning)]/30 text-[var(--color-warning)]">
          {t('compiler.typstEngineMissing', { engine: currentTypstEngine })}
        </div>
      )}

      <SettingItem
        label={t('compiler.typstFontEndpoint')}
        description={t('compiler.typstFontEndpointDesc')}
      >
        <input
          type="text"
          value={settings.compiler.typstFontEndpoint}
          onChange={(e) =>
            settingsService.updateCompiler({ typstFontEndpoint: e.target.value.trim() })
          }
          placeholder="https://your-cdn.example.com/extra-fonts/manifest.json"
          className={inputMonoClassName}
        />
      </SettingItem>

      <SettingCard className="mt-4" title={t('compiler.syncTexTitle')}>
        <ul className="text-xs text-[var(--color-text-muted)] space-y-1">
          <li>• {t('compiler.syncTexLocalSupport')}</li>
          <li>• {t('compiler.syncTexWasmSupport')}</li>
          <li>• {t('compiler.syncTexTypstSupport')}</li>
        </ul>
      </SettingCard>

      {!projectPath && (
        <SettingCard className="bg-[var(--color-warning-muted)] border-[var(--color-warning)]/30">
          <p className="text-xs text-[var(--color-warning)]">{t('compiler.noProjectHint')}</p>
          <ul className="text-xs text-[var(--color-text-muted)] mt-2 space-y-1">
            <li>• {t('compiler.localProjectOptions')}</li>
            <li>• {t('compiler.remoteProjectOptions')}</li>
          </ul>
        </SettingCard>
      )}
    </>
  );
};

