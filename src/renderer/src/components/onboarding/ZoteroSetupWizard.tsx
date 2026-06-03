/**
 * @file ZoteroSetupWizard.tsx — Zotero just-in-time setup wizard (M1)
 * @description 3-step onboarding: detect Zotero -> verify Local API ->
 *              recommend Better BibTeX (skippable). Triggered by
 *              `@cite:` typing or `\cite{}` hover, NOT on app boot
 *              (PM-3 decision).
 *
 *              Visual style mirrors `OverleafDownloadDialog`: rounded
 *              modal, framer-motion entrance, design-token colors.
 *              State machine lives in `useZoteroWizard`.
 */

import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle,
  ArrowLeft,
  BookMarked,
  Check,
  ExternalLink,
  Loader2,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import type React from 'react';
import { api } from '../../api';
import { useTranslation } from '../../locales';
import type { ZoteroWizardController, WizardStepState } from '../../hooks/useZoteroWizard';

interface ZoteroSetupWizardProps {
  controller: ZoteroWizardController;
}

const TOTAL_STEPS = 3;

const ZOTERO_DOWNLOAD_URL = 'https://www.zotero.org/download/';
const ZOTERO_LOCAL_API_DOCS_URL = 'https://www.zotero.org/support/kb/connector_zotero_unavailable';
const BBT_INSTALL_URL = 'https://retorque.re/zotero-better-bibtex/installation/';

export const ZoteroSetupWizard: React.FC<ZoteroSetupWizardProps> = ({ controller }) => {
  const { t } = useTranslation();

  if (!controller.isOpen) {
    return null;
  }

  const openExternal = (url: string) => {
    void api.app.openExternal(url);
  };

  return (
    <AnimatePresence>
      <motion.div
        key="zotero-wizard-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-md"
        style={{ background: 'var(--color-backdrop)' }}
        onClick={controller.close}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 16 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 16 }}
          className="mx-4 flex max-h-[82vh] w-full max-w-2xl flex-col rounded-[28px] border p-6 shadow-[0_32px_90px_rgba(15,23,42,0.18)]"
          style={{
            background:
              'linear-gradient(180deg, rgba(255,255,255,0.97) 0%, rgba(250,249,245,0.95) 100%)',
            borderColor: 'rgba(148,163,184,0.2)',
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <WizardHeader onClose={controller.close} />

          <div className="mb-4 flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--color-text-muted)]">
              {t('zoteroWizard.stepLabel', {
                current: controller.currentStep,
                total: TOTAL_STEPS,
              })}
            </span>
            <StepDots current={controller.currentStep} total={TOTAL_STEPS} />
          </div>

          <div className="flex-1 overflow-y-auto">
            {controller.currentStep === 1 && (
              <StepZoteroInstall
                state={controller.zoteroStep}
                detectedPath={controller.detection?.path}
                onRetry={() => void controller.recheckZotero()}
                onOpenDownload={() => openExternal(ZOTERO_DOWNLOAD_URL)}
              />
            )}

            {controller.currentStep === 2 && (
              <StepLocalApi
                state={controller.localApiStep}
                onRetry={() => void controller.recheckLocalApi()}
                onOpenInstructions={() => openExternal(ZOTERO_LOCAL_API_DOCS_URL)}
              />
            )}

            {controller.currentStep === 3 && (
              <StepBetterBibTex
                state={controller.bbtStep}
                skipped={controller.skippedBBT}
                onRetry={() => void controller.recheckBBT()}
                onSkip={controller.skipBBT}
                onOpenInstall={() => openExternal(BBT_INSTALL_URL)}
              />
            )}
          </div>

          <WizardFooter controller={controller} />
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};

// ============================================================================
// Sub-components
// ============================================================================

const WizardHeader: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t } = useTranslation();
  return (
    <div className="mb-6 flex items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <div
          className="flex h-11 w-11 items-center justify-center rounded-2xl"
          style={{ background: 'rgba(168, 85, 247, 0.1)', color: '#7c3aed' }}
        >
          <BookMarked className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">
            {t('zoteroWizard.title')}
          </h2>
          <p className="text-xs text-[var(--color-text-muted)]">{t('zoteroWizard.subtitle')}</p>
        </div>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="flex h-10 w-10 items-center justify-center rounded-2xl border"
        style={{
          background: 'rgba(255,255,255,0.84)',
          borderColor: 'rgba(148,163,184,0.18)',
          color: 'var(--color-text-muted)',
        }}
      >
        <X className="h-4.5 w-4.5" />
      </button>
    </div>
  );
};

const StepDots: React.FC<{ current: number; total: number }> = ({ current, total }) => (
  <div className="flex gap-1.5">
    {Array.from({ length: total }, (_, i) => i + 1).map((idx) => (
      <div
        key={idx}
        className="h-1.5 w-8 rounded-full"
        style={{
          background:
            idx < current
              ? '#7c3aed'
              : idx === current
                ? 'rgba(124,58,237,0.5)'
                : 'rgba(148,163,184,0.25)',
        }}
      />
    ))}
  </div>
);

// ----- Step 1: Zotero install -----

const StepZoteroInstall: React.FC<{
  state: WizardStepState;
  detectedPath?: string;
  onRetry: () => void;
  onOpenDownload: () => void;
}> = ({ state, detectedPath, onRetry, onOpenDownload }) => {
  const { t } = useTranslation();
  return (
    <StepShell title={t('zoteroWizard.step1.title')}>
      {state.status === 'ok' ? (
        <SuccessCard
          title={t('zoteroWizard.step1.okTitle')}
          hint={t('zoteroWizard.step1.okHint', { path: detectedPath ?? '—' })}
        />
      ) : (
        <MissingCard
          title={t('zoteroWizard.step1.missingTitle')}
          hint={t('zoteroWizard.step1.missingHint')}
          error={state.error}
          checking={state.status === 'checking'}
        >
          <LinkButton onClick={onOpenDownload} label={t('zoteroWizard.step1.downloadLink')} />
          <ActionButton
            onClick={onRetry}
            label={t('zoteroWizard.step1.haveInstalledBtn')}
            checking={state.status === 'checking'}
          />
        </MissingCard>
      )}
    </StepShell>
  );
};

// ----- Step 2: Local API -----

const StepLocalApi: React.FC<{
  state: WizardStepState;
  onRetry: () => void;
  onOpenInstructions: () => void;
}> = ({ state, onRetry, onOpenInstructions }) => {
  const { t } = useTranslation();
  return (
    <StepShell title={t('zoteroWizard.step2.title')}>
      {state.status === 'ok' ? (
        <SuccessCard
          title={t('zoteroWizard.step2.okTitle')}
          hint={t('zoteroWizard.step2.okHint')}
        />
      ) : (
        <MissingCard
          title={t('zoteroWizard.step2.missingTitle')}
          hint={t('zoteroWizard.step2.missingHint')}
          error={state.error}
          checking={state.status === 'checking'}
        >
          <LinkButton
            onClick={onOpenInstructions}
            label={t('zoteroWizard.step2.instructionsLink')}
          />
          <ActionButton
            onClick={onRetry}
            label={t('zoteroWizard.step2.verifyBtn')}
            checking={state.status === 'checking'}
          />
        </MissingCard>
      )}
    </StepShell>
  );
};

// ----- Step 3: Better BibTeX (skippable) -----

const StepBetterBibTex: React.FC<{
  state: WizardStepState;
  skipped: boolean;
  onRetry: () => void;
  onSkip: () => void;
  onOpenInstall: () => void;
}> = ({ state, skipped, onRetry, onSkip, onOpenInstall }) => {
  const { t } = useTranslation();

  if (skipped) {
    return (
      <StepShell title={t('zoteroWizard.step3.title')}>
        <div
          className="rounded-[20px] border p-4"
          style={{ background: 'rgba(245,158,11,0.08)', borderColor: 'rgba(245,158,11,0.2)' }}
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" style={{ color: '#d97706' }} />
            <div>
              <p className="text-sm font-medium" style={{ color: '#92400e' }}>
                {t('zoteroWizard.step3.skipNoteTitle')}
              </p>
              <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                {t('zoteroWizard.step3.skipNoteHint')}
              </p>
            </div>
          </div>
        </div>
      </StepShell>
    );
  }

  return (
    <StepShell title={t('zoteroWizard.step3.title')}>
      {state.status === 'ok' ? (
        <SuccessCard
          title={t('zoteroWizard.step3.okTitle')}
          hint={t('zoteroWizard.step3.okHint')}
        />
      ) : (
        <MissingCard
          title={t('zoteroWizard.step3.missingTitle')}
          hint={t('zoteroWizard.step3.missingHint')}
          error={state.error}
          checking={state.status === 'checking'}
        >
          <LinkButton onClick={onOpenInstall} label={t('zoteroWizard.step3.installLink')} />
          <ActionButton
            onClick={onRetry}
            label={t('zoteroWizard.step3.haveInstalledBtn')}
            checking={state.status === 'checking'}
          />
          <button
            type="button"
            onClick={onSkip}
            className="ml-auto rounded-xl px-3 py-2 text-xs font-medium"
            style={{ color: 'var(--color-text-muted)' }}
          >
            {t('zoteroWizard.skipBBT')}
          </button>
        </MissingCard>
      )}
    </StepShell>
  );
};

// ----- Shared step primitives -----

const StepShell: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="space-y-4">
    <h3 className="text-base font-semibold text-[var(--color-text-primary)]">{title}</h3>
    {children}
  </div>
);

const SuccessCard: React.FC<{ title: string; hint: string }> = ({ title, hint }) => (
  <div
    className="rounded-[20px] border p-4"
    style={{ background: 'rgba(34,197,94,0.08)', borderColor: 'rgba(34,197,94,0.2)' }}
  >
    <div className="flex items-start gap-3">
      <div
        className="flex h-8 w-8 items-center justify-center rounded-xl"
        style={{ background: '#22c55e', color: 'white' }}
      >
        <Check className="h-4 w-4" />
      </div>
      <div>
        <p className="text-sm font-medium" style={{ color: '#166534' }}>
          {title}
        </p>
        <p className="mt-1 text-xs text-[var(--color-text-secondary)]">{hint}</p>
      </div>
    </div>
  </div>
);

const MissingCard: React.FC<{
  title: string;
  hint: string;
  error?: string;
  checking: boolean;
  children: React.ReactNode;
}> = ({ title, hint, error, checking, children }) => {
  const { t } = useTranslation();
  return (
    <div
      className="rounded-[20px] border p-4"
      style={{
        background: 'rgba(248,113,113,0.06)',
        borderColor: 'rgba(248,113,113,0.18)',
      }}
    >
      <div className="flex items-start gap-3">
        <Sparkles className="mt-0.5 h-5 w-5 shrink-0" style={{ color: '#dc2626' }} />
        <div className="flex-1">
          <p className="text-sm font-medium" style={{ color: '#991b1b' }}>
            {title}
          </p>
          <p className="mt-1 text-xs text-[var(--color-text-secondary)]">{hint}</p>
          {error && (
            <p className="mt-2 text-xs" style={{ color: '#dc2626' }}>
              {error}
            </p>
          )}
          {checking && (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>{t('zoteroWizard.checking')}</span>
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">{children}</div>
        </div>
      </div>
    </div>
  );
};

const LinkButton: React.FC<{ onClick: () => void; label: string }> = ({ onClick, label }) => (
  <button
    type="button"
    onClick={onClick}
    className="flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-medium"
    style={{
      background: 'rgba(255,255,255,0.84)',
      borderColor: 'rgba(148,163,184,0.18)',
      color: 'var(--color-text-primary)',
    }}
  >
    <ExternalLink className="h-3.5 w-3.5" />
    {label}
  </button>
);

const ActionButton: React.FC<{ onClick: () => void; label: string; checking: boolean }> = ({
  onClick,
  label,
  checking,
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={checking}
    className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
    style={{ background: '#7c3aed' }}
  >
    {checking ? (
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
    ) : (
      <RefreshCw className="h-3.5 w-3.5" />
    )}
    {label}
  </button>
);

// ----- Footer (nav buttons) -----

const WizardFooter: React.FC<{ controller: ZoteroWizardController }> = ({ controller }) => {
  const { t } = useTranslation();
  const { currentStep, zoteroStep, localApiStep, bbtStep, skippedBBT } = controller;

  const canGoNext =
    (currentStep === 1 && zoteroStep.status === 'ok') ||
    (currentStep === 2 && localApiStep.status === 'ok') ||
    (currentStep === 3 && (bbtStep.status === 'ok' || skippedBBT));

  const isLastStep = currentStep === TOTAL_STEPS;

  return (
    <div
      className="mt-6 flex items-center justify-between gap-3 border-t pt-4"
      style={{ borderColor: 'rgba(148,163,184,0.15)' }}
    >
      <button
        type="button"
        onClick={controller.goBack}
        disabled={currentStep === 1}
        className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium disabled:opacity-40"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {t('zoteroWizard.back')}
      </button>

      <button
        type="button"
        onClick={isLastStep ? controller.finish : controller.goNext}
        disabled={!canGoNext}
        className="rounded-xl px-4 py-2 text-xs font-semibold text-white disabled:opacity-40"
        style={{ background: '#7c3aed' }}
      >
        {isLastStep ? t('zoteroWizard.finish') : t('zoteroWizard.next')}
      </button>
    </div>
  );
};

export default ZoteroSetupWizard;
