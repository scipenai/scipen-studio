/**
 * @file CompilerTab.tsx - Compiler Settings Tab
 * @description Configures compiler, Overleaf sync and local replica settings
 */

import { Check, FolderSync, RefreshCw, X, Zap } from 'lucide-react';
import type React from 'react';
import { useEffect, useState } from 'react';
import { type LocalReplicaConfig, type SyncResult, api } from '../../api';
import { useTranslation } from '../../locales';
import { getSettingsService } from '../../services/core/ServiceRegistry';
import { useProjectPath, useSettings } from '../../services/core/hooks';
import type { LaTeXEngine, OverleafCompiler } from '../../types';
import { Button, Input } from '../ui';
import {
  SectionTitle,
  SettingCard,
  SettingItem,
  inputClassName,
  selectClassName,
} from './SettingsUI';

const isRemotePath = (path: string | null): boolean => {
  if (!path) return false;
  return path.startsWith('overleaf://') || path.startsWith('overleaf:');
};

const OverleafSettings: React.FC = () => {
  const { t } = useTranslation();
  // Using the new service architecture
  const settings = useSettings();
  const settingsService = getSettingsService();

  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginStatus, setLoginStatus] = useState<{
    success: boolean;
    message: string;
    userId?: string;
  } | null>(null);
  const [updatingCompiler, setUpdatingCompiler] = useState(false);
  const [compilerUpdateStatus, setCompilerUpdateStatus] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  const overleafConfig = settings.compiler.overleaf || {
    serverUrl: 'https://www.overleaf.com',
    cookies: '',
    projectId: '',
    remoteCompiler: 'pdflatex',
  };

  // Sync compiler changes to Overleaf server
  const handleCompilerChange = async (newCompiler: string) => {
    settingsService.updateCompiler({
      overleaf: { ...overleafConfig, remoteCompiler: newCompiler as OverleafCompiler },
    });

    if (overleafConfig.projectId) {
      setUpdatingCompiler(true);
      setCompilerUpdateStatus(null);
      try {
        const result = await api.overleaf.updateSettings(overleafConfig.projectId, {
          compiler: newCompiler,
        });
        if (result.success) {
          setCompilerUpdateStatus({
            success: true,
            message: t('compiler.overleaf.compilerSynced'),
          });
        } else {
          setCompilerUpdateStatus({
            success: false,
            message: result.error || t('compiler.overleaf.syncFailed'),
          });
        }
      } catch (error) {
        setCompilerUpdateStatus({
          success: false,
          message: error instanceof Error ? error.message : t('compiler.overleaf.syncFailed'),
        });
      } finally {
        setUpdatingCompiler(false);
        setTimeout(() => setCompilerUpdateStatus(null), 3000);
      }
    }
  };

  const testConnection = async () => {
    setTestingConnection(true);
    setConnectionStatus(null);
    try {
      const result = await api.overleaf.testConnection(overleafConfig.serverUrl);
      setConnectionStatus(result);
    } catch (error) {
      setConnectionStatus({
        success: false,
        message: error instanceof Error ? error.message : t('compiler.overleaf.connectionFailed'),
      });
    } finally {
      setTestingConnection(false);
    }
  };

  const handleLogin = async () => {
    setLoggingIn(true);
    setLoginStatus(null);
    try {
      const result = await api.overleaf.login({
        serverUrl: overleafConfig.serverUrl,
        cookies: overleafConfig.cookies,
      });
      setLoginStatus({
        success: result.success,
        message:
          result.message ||
          (result.success
            ? t('compiler.overleaf.loginSuccess')
            : t('compiler.overleaf.loginFailed')),
      });
    } catch (error) {
      setLoginStatus({
        success: false,
        message: error instanceof Error ? error.message : t('compiler.overleaf.loginFailed'),
      });
    } finally {
      setLoggingIn(false);
    }
  };

  return (
    <>
      <SectionTitle>{t('compiler.overleaf.title')}</SectionTitle>
      <p className="text-xs text-[var(--color-text-muted)] mb-3">{t('compiler.overleaf.desc')}</p>

      <SettingItem
        label={t('compiler.overleaf.serverUrl')}
        description={t('compiler.overleaf.serverUrlDesc')}
      >
        <input
          type="text"
          value={overleafConfig.serverUrl}
          onChange={(e) =>
            settingsService.updateCompiler({
              overleaf: { ...overleafConfig, serverUrl: e.target.value },
            })
          }
          placeholder="https://www.overleaf.com"
          className={inputClassName}
        />
      </SettingItem>

      <Button
        onClick={testConnection}
        disabled={testingConnection}
        variant="secondary"
        size="sm"
        fullWidth
        leftIcon={
          testingConnection ? <RefreshCw size={12} className="animate-spin" /> : <Zap size={12} />
        }
      >
        {t('compiler.overleaf.testConnection')}
      </Button>
      {connectionStatus && (
        <div
          className={`mt-2 p-2 rounded-lg text-xs flex items-center gap-1 ${connectionStatus.success ? 'bg-[var(--color-success-muted)] text-[var(--color-success)]' : 'bg-[var(--color-error-muted)] text-[var(--color-error)]'}`}
        >
          {connectionStatus.success ? <Check size={12} /> : <X size={12} />}
          {connectionStatus.message}
        </div>
      )}

      <SectionTitle>{t('compiler.overleaf.auth')}</SectionTitle>
      <p className="text-xs text-[var(--color-text-muted)] mb-2">
        {t('compiler.overleaf.authDesc')}
      </p>

      <SettingItem
        label={t('compiler.overleaf.cookies')}
        description={t('compiler.overleaf.cookiesDesc')}
      >
        <Input
          type="password"
          value={overleafConfig.cookies || ''}
          onChange={(e) =>
            settingsService.updateCompiler({
              overleaf: { ...overleafConfig, cookies: e.target.value },
            })
          }
          placeholder="overleaf_session2=..."
        />
      </SettingItem>

      <Button
        onClick={handleLogin}
        disabled={loggingIn || !overleafConfig.cookies}
        variant="primary"
        size="sm"
        fullWidth
        leftIcon={
          loggingIn ? <RefreshCw size={12} className="animate-spin" /> : <Check size={12} />
        }
      >
        {loggingIn ? t('compiler.overleaf.loggingIn') : t('compiler.overleaf.loginOverleaf')}
      </Button>
      {loginStatus && (
        <div
          className={`mt-2 p-2 rounded-lg text-xs flex items-center gap-1 ${loginStatus.success ? 'bg-[var(--color-success-muted)] text-[var(--color-success)]' : 'bg-[var(--color-error-muted)] text-[var(--color-error)]'}`}
        >
          {loginStatus.success ? <Check size={12} /> : <X size={12} />}
          {loginStatus.message}
          {loginStatus.userId && (
            <span className="ml-2 text-[var(--color-text-muted)]">ID: {loginStatus.userId}</span>
          )}
        </div>
      )}

      <SectionTitle>{t('compiler.overleaf.compileSettings')}</SectionTitle>

      <SettingItem
        label={t('compiler.overleaf.remoteCompiler')}
        description={t('compiler.overleaf.remoteCompilerDesc')}
      >
        <div className="flex items-center gap-2">
          <select
            value={overleafConfig.remoteCompiler || 'pdflatex'}
            onChange={(e) => handleCompilerChange(e.target.value)}
            disabled={updatingCompiler}
            className={`${selectClassName} flex-1`}
          >
            <option value="pdflatex">pdfLaTeX</option>
            <option value="latex">LaTeX</option>
            <option value="xelatex">{t('compiler.overleaf.xelatexChinese')}</option>
            <option value="lualatex">LuaLaTeX</option>
          </select>
          {updatingCompiler && (
            <RefreshCw size={14} className="animate-spin text-[var(--color-accent)]" />
          )}
        </div>
        {compilerUpdateStatus && (
          <div
            className={`mt-1 text-xs flex items-center gap-1 ${compilerUpdateStatus.success ? 'text-[var(--color-success)]' : 'text-[var(--color-error)]'}`}
          >
            {compilerUpdateStatus.success ? <Check size={12} /> : <X size={12} />}
            {compilerUpdateStatus.message}
          </div>
        )}
      </SettingItem>

      <SettingCard className="mt-4" title={t('compiler.overleaf.instructions')}>
        <ol className="text-xs text-[var(--color-text-muted)] space-y-1 list-decimal list-inside">
          <li>{t('compiler.overleaf.step1')}</li>
          <li>{t('compiler.overleaf.step2')}</li>
          <li>{t('compiler.overleaf.step3')}</li>
          <li>{t('compiler.overleaf.step4')}</li>
          <li>{t('compiler.overleaf.step5')}</li>
          <li>{t('compiler.overleaf.step6')}</li>
        </ol>
      </SettingCard>

      <SettingCard className="mt-3" title={t('compiler.overleaf.features')}>
        <ul className="text-xs text-[var(--color-text-muted)] space-y-1">
          <li>✓ {t('compiler.overleaf.feature1')}</li>
          <li>✓ {t('compiler.overleaf.feature2')}</li>
          <li>✓ {t('compiler.overleaf.feature3')}</li>
          <li>✓ {t('compiler.overleaf.feature4')}</li>
        </ul>
      </SettingCard>
    </>
  );
};

const LocalReplicaSettings: React.FC = () => {
  const { t } = useTranslation();
  const settings = useSettings();
  const projectPath = useProjectPath();

  const [config, setConfig] = useState<LocalReplicaConfig | null>(null);
  const [isWatching, setIsWatching] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [localPath, setLocalPath] = useState('');
  const [isInitializing, setIsInitializing] = useState(false);

  const projectId = settings.compiler.overleaf?.projectId || '';
  const projectName = projectPath?.replace(/^overleaf:\/\/[^/]+\/?/, '') || 'Overleaf Project';

  useEffect(() => {
    const loadConfig = async () => {
      try {
        const savedConfig = await api.localReplica.getConfig();
        if (savedConfig) {
          setConfig(savedConfig);
          setLocalPath(savedConfig.localPath);
        }
        const watching = await api.localReplica.isWatching();
        setIsWatching(watching);
      } catch (error) {
        console.error('Failed to load Local Replica config:', error);
      }
    };
    loadConfig();
  }, []);

  const handleInit = async () => {
    if (!localPath || !projectId) return;

    setIsInitializing(true);
    try {
      const success = await api.localReplica.init({
        projectId,
        projectName,
        localPath,
        enabled: true,
      });

      if (success) {
        const newConfig = await api.localReplica.getConfig();
        setConfig(newConfig);
      }
    } catch (error) {
      console.error('Failed to init Local Replica:', error);
    } finally {
      setIsInitializing(false);
    }
  };

  const handleSyncFromRemote = async () => {
    setIsSyncing(true);
    setSyncResult(null);
    try {
      const result = await api.localReplica.syncFromRemote();
      setSyncResult(result);
    } catch (error) {
      console.error('Sync from remote failed:', error);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleToggleWatching = async () => {
    try {
      if (isWatching) {
        await api.localReplica.stopWatching();
        setIsWatching(false);
      } else {
        await api.localReplica.startWatching();
        setIsWatching(true);
      }
    } catch (error) {
      console.error('Toggle watching failed:', error);
    }
  };

  return (
    <>
      <div className="mt-6">
        <SectionTitle>{t('compiler.localReplica.title')}</SectionTitle>
      </div>

      <SettingCard>
        <p className="text-xs text-[var(--color-text-muted)] mb-3">
          {t('compiler.localReplica.desc')}
        </p>

        <SettingItem
          label={t('compiler.localReplica.localPath')}
          description={t('compiler.localReplica.localPathDesc')}
        >
          <Input
            value={localPath}
            onChange={(e) => setLocalPath(e.target.value)}
            placeholder={t('compiler.localReplica.localPathPlaceholder')}
            className={inputClassName}
          />
        </SettingItem>

        {!config ? (
          <Button
            onClick={handleInit}
            disabled={!localPath || isInitializing}
            className="mt-3 w-full"
          >
            {isInitializing ? (
              <>
                <RefreshCw className="animate-spin mr-2" size={14} />
                {t('compiler.localReplica.initializing')}
              </>
            ) : (
              <>
                <FolderSync className="mr-2" size={14} />
                {t('compiler.localReplica.initLocalReplica')}
              </>
            )}
          </Button>
        ) : (
          <>
            <div className="flex gap-2 mt-3">
              <Button
                variant="secondary"
                size="sm"
                onClick={handleSyncFromRemote}
                disabled={isSyncing}
                className="flex-1"
              >
                {isSyncing ? (
                  <>
                    <RefreshCw className="animate-spin mr-2" size={14} />
                    {t('compiler.localReplica.syncing')}
                  </>
                ) : (
                  t('compiler.localReplica.pullToLocal')
                )}
              </Button>
              <Button
                variant={isWatching ? 'primary' : 'secondary'}
                size="sm"
                onClick={handleToggleWatching}
                className="flex-1"
              >
                {isWatching
                  ? t('compiler.localReplica.stopAutoSync')
                  : t('compiler.localReplica.startAutoSync')}
              </Button>
            </div>

            {syncResult && (
              <div
                className={`mt-3 p-2 rounded text-xs ${
                  syncResult.errors.length > 0
                    ? 'bg-[var(--color-error-muted)] text-[var(--color-error)]'
                    : 'bg-[var(--color-success-muted)] text-[var(--color-success)]'
                }`}
              >
                {syncResult.errors.length > 0 ? (
                  <span>
                    {t('compiler.localReplica.syncFailed')} {syncResult.errors[0]}
                  </span>
                ) : (
                  <span>
                    {t('compiler.localReplica.syncSuccess', {
                      synced: syncResult.synced,
                      skipped: syncResult.skipped,
                    })}
                  </span>
                )}
              </div>
            )}

            {isWatching && (
              <div className="mt-3 p-2 rounded bg-[var(--color-success-muted)] text-[var(--color-success)] text-xs flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-[var(--color-success)] animate-pulse" />
                {t('compiler.localReplica.autoSyncEnabled')}
              </div>
            )}
          </>
        )}
      </SettingCard>

      <SettingCard className="mt-3" title={t('compiler.localReplica.syncInstructions')}>
        <ul className="text-xs text-[var(--color-text-muted)] space-y-1">
          <li>• {t('compiler.localReplica.syncHint1')}</li>
          <li>• {t('compiler.localReplica.syncHint2')}</li>
          <li>• {t('compiler.localReplica.syncHint3')}</li>
          <li>• {t('compiler.localReplica.syncHint4')}</li>
        </ul>
      </SettingCard>
    </>
  );
};

export const CompilerTab: React.FC = () => {
  const { t } = useTranslation();
  // Using the new service architecture
  const settings = useSettings();
  const settingsService = getSettingsService();
  const projectPath = useProjectPath();

  const isRemoteProject = isRemotePath(projectPath);

  return (
    <>
      <SectionTitle>{t('compiler.title')}</SectionTitle>

      {projectPath && (
        <div
          className={`mb-4 p-2 rounded-lg text-xs ${isRemoteProject ? 'bg-[var(--color-success-muted)] border border-[var(--color-success)]/30 text-[var(--color-success)]' : 'bg-[var(--color-accent-muted)] border border-[var(--color-accent)]/30 text-[var(--color-accent)]'}`}
        >
          {isRemoteProject
            ? `📡 ${t('compiler.remoteProject')}`
            : `💻 ${t('compiler.localProject')}`}
        </div>
      )}

      {!isRemoteProject && (
        <SettingItem label={t('compiler.engine')} description={t('compiler.engineDesc')}>
          <select
            value={settings.compiler.engine === 'overleaf' ? 'xelatex' : settings.compiler.engine}
            onChange={(e) =>
              settingsService.updateCompiler({ engine: e.target.value as LaTeXEngine })
            }
            className={selectClassName}
          >
            <option value="xelatex">{t('compiler.xelatexRecommended')}</option>
            <option value="lualatex">{t('compiler.lualatex')}</option>
            <option value="pdflatex">{t('compiler.pdflatex')}</option>
            <option value="tectonic">{t('compiler.tectonic')}</option>
          </select>
        </SettingItem>
      )}

      {isRemoteProject && <OverleafSettings />}
      {isRemoteProject && <LocalReplicaSettings />}

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
