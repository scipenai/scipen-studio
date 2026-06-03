/**
 * @file WelcomeHero.tsx - Welcome 屏左列
 * @description logo + title + subtitle + 2 个 action cards(本地/远程)+ feature highlights
 */

import { motion } from 'framer-motion';
import { Cloud, FolderOpen, Loader2, Sparkles, Zap } from 'lucide-react';
import type React from 'react';
import logoFull from '../../assets/logo-full.svg';
import { useTranslation } from '../../locales';

export interface WelcomeHeroProps {
  appVersion: string;
  isOpeningProject: boolean;
  isOpeningAnyProject: boolean;
  onOpenProject: () => void;
  onOpenRemote: () => void;
}

export const WelcomeHero: React.FC<WelcomeHeroProps> = ({
  appVersion,
  isOpeningProject,
  isOpeningAnyProject,
  onOpenProject,
  onOpenRemote,
}) => {
  const { t } = useTranslation();
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.1, duration: 0.6 }}
      className="max-w-md shrink-0"
    >
      {/* Logo & Title */}
      <div className="mb-6 flex flex-col gap-4">
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.2, type: 'spring', stiffness: 200 }}
        >
          <img src={logoFull} alt="SciPen" className="h-16 w-auto" />
        </motion.div>
        <div>
          <p className="text-lg" style={{ color: 'var(--color-text-muted)' }}>
            {t('welcome.title')}
          </p>
          <p className="mt-1 text-sm" style={{ color: 'var(--color-text-muted)' }}>
            {appVersion ? `v${appVersion}` : ''}
          </p>
        </div>
      </div>

      {/* Subtitle */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.4 }}
        className="mb-8"
      >
        <p className="mb-2 text-xl font-medium" style={{ color: 'var(--color-text-primary)' }}>
          {t('welcome.subtitle')}
        </p>
        <p className="text-sm leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
          {t('welcome.description')}
        </p>
      </motion.div>

      {/* Action Cards */}
      <div className="mb-6 grid grid-cols-2 gap-3">
        <motion.button
          type="button"
          onClick={onOpenProject}
          disabled={isOpeningAnyProject}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5 }}
          whileHover={
            isOpeningAnyProject
              ? undefined
              : { y: -4, boxShadow: '0 12px 40px rgba(245,158,11,0.15)' }
          }
          whileTap={isOpeningAnyProject ? undefined : { scale: 0.98 }}
          className={`group relative overflow-hidden rounded-2xl p-5 text-left transition-all duration-300 ${
            isOpeningAnyProject ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'
          }`}
          style={{
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border)',
          }}
        >
          <div
            className="absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
            style={{
              background: 'linear-gradient(135deg, rgba(245,158,11,0.1) 0%, transparent 60%)',
            }}
          />
          <div className="relative">
            <div
              className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl transition-transform group-hover:scale-110"
              style={{ background: 'rgba(245,158,11,0.15)' }}
            >
              {isOpeningProject ? (
                <Loader2 className="h-5 w-5 animate-spin text-amber-400" />
              ) : (
                <FolderOpen className="h-5 w-5 text-amber-400" />
              )}
            </div>
            <h3
              className="mb-1 text-sm font-semibold"
              style={{ color: 'var(--color-text-primary)' }}
            >
              {t('welcome.openLocal')}
            </h3>
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {t('welcome.openLocalDesc')}
            </p>
          </div>
        </motion.button>

        <motion.button
          type="button"
          onClick={onOpenRemote}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6 }}
          whileHover={{ y: -4, boxShadow: '0 12px 40px rgba(139,92,246,0.15)' }}
          whileTap={{ scale: 0.98 }}
          className="group relative cursor-pointer overflow-hidden rounded-2xl p-5 text-left transition-all duration-300"
          style={{
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border)',
          }}
        >
          <div
            className="absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
            style={{
              background: 'linear-gradient(135deg, rgba(139,92,246,0.1) 0%, transparent 60%)',
            }}
          />
          <div className="relative">
            <div
              className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl transition-transform group-hover:scale-110"
              style={{ background: 'rgba(139,92,246,0.15)' }}
            >
              <Cloud className="h-5 w-5 text-violet-400" />
            </div>
            <h3
              className="mb-1 text-sm font-semibold"
              style={{ color: 'var(--color-text-primary)' }}
            >
              {t('welcome.openRemote')}
            </h3>
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {t('welcome.openRemoteDesc')}
            </p>
          </div>
        </motion.button>
      </div>

      {/* Feature Highlights */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.7 }}
        className="flex items-center gap-4 text-xs"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <div className="flex items-center gap-1.5">
          <Sparkles size={12} className="text-cyan-400" />
          <span>{t('welcome.featureAI')}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Cloud size={12} className="text-violet-400" />
          <span>{t('welcome.featureOverleaf')}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Zap size={12} className="text-amber-400" />
          <span>{t('welcome.featurePreview')}</span>
        </div>
      </motion.div>
    </motion.div>
  );
};
