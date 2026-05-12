/**
 * @file CompilerTab.tsx - Compiler Settings Tab
 * @description Configures compiler settings for local projects
 */

import type React from 'react';
import { useTranslation } from '../../locales';
import { getSettingsService } from '../../services/core/ServiceRegistry';
import { useProjectPath, useSettings } from '../../services/core/hooks';
import type { LaTeXEngine, TypstEngine } from '../../types';
import {
  SectionTitle,
  SettingCard,
  SettingItem,
  inputClassName,
  selectClassName,
} from './SettingsUI';

export const CompilerTab: React.FC = () => {
  const { t } = useTranslation();
  const settings = useSettings();
  const settingsService = getSettingsService();
  const projectPath = useProjectPath();

  return (
    <>
      <SectionTitle>{t('compiler.title')}</SectionTitle>

      {projectPath && (
        <div className="mb-4 p-2 rounded-lg text-xs bg-[var(--color-accent-muted)] border border-[var(--color-accent)]/30 text-[var(--color-accent)]">
          {`\uD83D\uDCBB ${t('compiler.localProject')}`}
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
          placeholder="https://latex.arxtect.cn/latex6/arxtect_version_20251120/"
          className={inputClassName}
        />
      </SettingItem>

      <SettingItem label={t('compiler.typstEngine')} description={t('compiler.typstEngineDesc')}>
        <select
          value={settings.compiler.typstEngine}
          onChange={(e) =>
            settingsService.updateCompiler({ typstEngine: e.target.value as TypstEngine })
          }
          className={selectClassName}
        >
          <option value="tinymist">{t('compiler.tinymist')}</option>
          <option value="typst">{t('compiler.typstCli')}</option>
        </select>
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
            <li>\u2022 {t('compiler.localProjectOptions')}</li>
            <li>\u2022 {t('compiler.remoteProjectOptions')}</li>
          </ul>
        </SettingCard>
      )}
    </>
  );
};
