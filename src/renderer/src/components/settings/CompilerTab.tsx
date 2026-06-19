/**
 * @file CompilerTab.tsx - Compiler Settings Tab
 * @description Configures compiler settings for local projects
 */

import { useEffect, useMemo, useState, type FC } from 'react';
import type {
  LaTeXCapabilities,
  TypstCapabilities,
} from '../../../../../shared/ipc/compile-contract';
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
type LatexCapsState = LaTeXCapabilities | null;

export const CompilerTab: FC = () => {
  const { t } = useTranslation();
  const settings = useSettings();
  const settingsService = getSettingsService();
  const projectPath = useProjectPath();
  const [latexCaps, setLatexCaps] = useState<LatexCapsState>(null);
  const [typstCaps, setTypstCaps] = useState<TypstCapsState>(null);
  /**
   * Draft for the font-endpoint input. We don't write to SettingsService on
   * every keystroke because trim()-on-change eats trailing whitespace mid-
   * paste; commit happens onBlur. The effect below re-syncs from external
   * settings changes (other panel, multi-window).
   */
  const [fontEndpointDraft, setFontEndpointDraft] = useState(
    settings.compiler.typstFontEndpoint,
  );
  useEffect(() => {
    setFontEndpointDraft(settings.compiler.typstFontEndpoint);
  }, [settings.compiler.typstFontEndpoint]);

  useEffect(() => {
    let cancelled = false;
    api.compile
      .getLaTeXCapabilities()
      .then((caps) => {
        if (cancelled) return;
        setLatexCaps(caps);
        logger.info('LaTeX capabilities probed', caps);
      })
      .catch((error) => {
        if (cancelled) return;
        logger.warn('LaTeX capability probe failed', { error: String(error) });
        setLatexCaps({
          cli: {
            pdflatex: { available: false, version: null },
            xelatex: { available: false, version: null },
            lualatex: { available: false, version: null },
            tectonic: { available: false, version: null },
          },
          wasm: {
            pdftex: { available: false, version: null },
            xetex: { available: false, version: null },
            lualatex: { available: false, version: null },
          },
        });
      });
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
  const typstOptions = useMemo<{ value: TypstEngine; label: string }[]>(() => {
    const options: { value: TypstEngine; label: string }[] = [];
    if (typstCaps) {
      if (typstCaps.cli.tinymist.available) {
        options.push({ value: 'tinymist', label: t('compiler.tinymist') });
      }
      if (typstCaps.cli.typst.available) {
        options.push({ value: 'typst', label: t('compiler.typstCli') });
      }
      if (typstCaps.wasm.available) {
        options.push({ value: 'wasm-typst', label: t('compiler.typstWasm') });
      }
    }
    return options;
  }, [t, typstCaps]);

  const currentTypstEngine = settings.compiler.typstEngine;
  const currentTypstEngineUnavailable =
    typstOptions.length > 0 && !typstOptions.some((opt) => opt.value === currentTypstEngine);

  const latexOptions = useMemo<{ value: LaTeXEngine; label: string }[]>(() => {
    const options: { value: LaTeXEngine; label: string }[] = [];
    if (latexCaps) {
      if (latexCaps.cli.xelatex.available) {
        options.push({ value: 'xelatex', label: t('compiler.xelatexRecommended') });
      }
      if (latexCaps.cli.lualatex.available) {
        options.push({ value: 'lualatex', label: t('compiler.lualatex') });
      }
      if (latexCaps.cli.pdflatex.available) {
        options.push({ value: 'pdflatex', label: t('compiler.pdflatex') });
      }
      if (latexCaps.cli.tectonic.available) {
        options.push({ value: 'tectonic', label: t('compiler.tectonic') });
      }
      if (latexCaps.wasm.pdftex.available) {
        options.push({ value: 'wasm-pdftex', label: t('compiler.wasmPdftex') });
      }
      if (latexCaps.wasm.xetex.available) {
        options.push({ value: 'wasm-xetex', label: t('compiler.wasmXetex') });
      }
      if (latexCaps.wasm.lualatex.available) {
        options.push({ value: 'wasm-lualatex', label: t('compiler.wasmLualatex') });
      }
    }
    return options;
  }, [latexCaps, t]);

  const currentLatexEngine = settings.compiler.engine;
  const currentLatexEngineUnavailable =
    latexOptions.length > 0 && !latexOptions.some((opt) => opt.value === currentLatexEngine);

  useEffect(() => {
    if (!currentLatexEngineUnavailable || latexOptions.length === 0) return;
    settingsService.updateCompiler({ engine: latexOptions[0].value });
  }, [currentLatexEngineUnavailable, latexOptions, settingsService]);

  useEffect(() => {
    if (!currentTypstEngineUnavailable || typstOptions.length === 0) return;
    settingsService.updateCompiler({ typstEngine: typstOptions[0].value });
  }, [currentTypstEngineUnavailable, settingsService, typstOptions]);

  return (
    <>
      <SectionTitle>{t('compiler.title')}</SectionTitle>

      {projectPath && (
        <div className="mb-4 p-2 rounded-lg text-xs bg-[var(--color-accent-muted)] border border-[var(--color-accent)]/30 text-[var(--color-accent)]">
          {`💻 ${t('compiler.localProject')}`}
        </div>
      )}

      <SettingItem label={t('compiler.engine')} description={t('compiler.engineDesc')}>
        {latexCaps === null ? (
          <span className="text-xs text-[var(--color-text-muted)]">
            {t('compiler.latexProbing')}
          </span>
        ) : latexOptions.length === 0 ? (
          <span className="text-xs text-[var(--color-warning)]">
            {t('compiler.latexNoEngine')}
          </span>
        ) : (
          <select
            value={currentLatexEngine}
            onChange={(e) =>
              settingsService.updateCompiler({ engine: e.target.value as LaTeXEngine })
            }
            className={selectClassName}
          >
            {latexOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        )}
      </SettingItem>

      {currentLatexEngineUnavailable && (
        <div className="mb-4 p-2 rounded-lg text-xs bg-[var(--color-warning-muted)] border border-[var(--color-warning)]/30 text-[var(--color-warning)]">
          {t('compiler.latexEngineMissing', { engine: currentLatexEngine })}
        </div>
      )}

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

      {currentTypstEngineUnavailable && (
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
          value={fontEndpointDraft}
          onChange={(e) => setFontEndpointDraft(e.target.value)}
          onBlur={(e) => {
            const next = e.target.value.trim();
            if (next !== settings.compiler.typstFontEndpoint) {
              settingsService.updateCompiler({ typstFontEndpoint: next });
            }
            setFontEndpointDraft(next);
          }}
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
