/**
 * @file ToolsPanel.tsx - Smart Tools Panel
 * @description Provides AI tool entries for PDF to LaTeX, Beamer generation, paper review
 */

import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle,
  Calculator,
  Check,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  FileCode,
  FileSearch,
  FileText,
  Image,
  Loader2,
  Play,
  Presentation,
  Square,
  Upload,
} from 'lucide-react';
import type React from 'react';
import { useEffect, useState } from 'react';
import { useEvent } from '../hooks';
import { useTranslation } from '../locales';
import { createLogger } from '../services/LogService';
import {
  getAgentToolsService,
  getUIService,
  useActiveTabPath,
  useAgentState,
  useEditorTabs,
  useSettings,
} from '../services/core';
import type { AgentProgress } from '../services/core/AgentToolsService';

const logger = createLogger('ToolsPanel');

interface AgentStatus {
  pdf2latex: boolean;
  reviewer: boolean;
  paper2beamer: boolean;
}

interface ToolResult {
  success: boolean;
  message: string;
  outputPath?: string;
  duration?: number;
}

export const ToolsPanel: React.FC = () => {
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [result, setResult] = useState<ToolResult | null>(null);

  const agentState = useAgentState();
  const uiService = getUIService();

  const isRunning = agentState.isRunning;
  const activeTool = agentState.activeTool;
  const progress = agentState.progress;

  const [pdfFile, setPdfFile] = useState<string | null>(null);
  const [texFile, setTexFile] = useState<string | null>(null);
  const [beamerDuration, setBeamerDuration] = useState(15);
  const [beamerTemplates, setBeamerTemplates] = useState<string[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);

  const [formulaImage, setFormulaImage] = useState<string | null>(null);
  const [formulaImageBase64, setFormulaImageBase64] = useState<string | null>(null);
  const [formulaImageMimeType, setFormulaImageMimeType] = useState<string>('image/png');
  const [formulaImagePreview, setFormulaImagePreview] = useState<string | null>(null);
  const [recognizedLatex, setRecognizedLatex] = useState<string | null>(null);
  const [isRecognizing, setIsRecognizing] = useState(false);
  const [copied, setCopied] = useState(false);

  const activeTabPath = useActiveTabPath();
  const settings = useSettings();
  const openTabs = useEditorTabs();
  const { t } = useTranslation();
  const activeTab = openTabs.find((t) => t.path === activeTabPath);

  useEffect(() => {
    const initializeComponent = async () => {
      const toolsService = getAgentToolsService();

      const result = await toolsService.checkAvailability();
      if (result.success && result.status) {
        setAgentStatus(result.status);
      } else {
        setAgentStatus({ pdf2latex: false, reviewer: false, paper2beamer: false });
      }

      const templates = await toolsService.getBeamerTemplates();
      setBeamerTemplates(templates);

      // Reset stuck tasks that have been running for more than 30 minutes
      if (agentState.isRunning && agentState.activeTool && agentState.startTime) {
        const runDuration = Date.now() - agentState.startTime;
        if (runDuration > 30 * 60 * 1000) {
          logger.warn('检测到长时间运行的任务，可能是僵尸状态，重置');
          uiService.resetAgentState();
        }
      }
    };

    initializeComponent();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Run only once on mount
  }, []);

  // useEvent automatically manages subscription and cleanup
  useEvent(getAgentToolsService().onProgress, (data: AgentProgress) => {
    if (data.type === agentState.activeTool) {
      uiService.setAgentState({ progress: data.message, message: data.message });
    }
  });

  // Auto-select if currently open tab is a .tex file
  useEffect(() => {
    if (activeTab?.path?.endsWith('.tex')) {
      setTexFile(activeTab.path);
    }
  }, [activeTab]);

  const handleSelectPdfFile = async () => {
    const result = await getAgentToolsService().selectFile('pdf');
    if (result) {
      setPdfFile(result.path);
    }
  };

  const handleSelectTexFile = async () => {
    const result = await getAgentToolsService().selectFile('tex');
    if (result) {
      setTexFile(result.path);
    }
  };

  const handleSelectFormulaImage = async () => {
    const result = await getAgentToolsService().selectFile('image');
    if (result?.ext) {
      const ext = result.ext.slice(1).toLowerCase();
      const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;

      setFormulaImage(result.path);
      setFormulaImageBase64(result.content || null);
      setFormulaImageMimeType(mimeType);
      if (result.content) {
        setFormulaImagePreview(`data:${mimeType};base64,${result.content}`);
      }
      setRecognizedLatex(null);
    }
  };

  const handleRecognizeFormula = async () => {
    if (!formulaImage || !formulaImageBase64 || isRecognizing) return;

    setIsRecognizing(true);
    setRecognizedLatex(null);

    try {
      // Read VLM config from SettingsService (main process)
      const { getSettingsService } = await import('../services/core/ServiceRegistry');
      const settingsService = getSettingsService();
      const aiConfig = await settingsService.getAIConfig();

      if (!aiConfig.providers || aiConfig.providers.length === 0) {
        throw new Error(t('tools.errors.configProvider'));
      }

      const providers = aiConfig.providers;
      const selectedModels = aiConfig.selectedModels;

      // Find the first enabled provider with API key
      const mainProvider = providers.find((p) => p.enabled && p.apiKey);
      if (!mainProvider) {
        throw new Error(t('tools.errors.enableProvider'));
      }

      // Use vision model config if available, otherwise fall back to main provider
      const visionSelection = selectedModels.vision;
      const visionProvider = visionSelection
        ? providers.find((p) => p.id === visionSelection.providerId)
        : mainProvider;

      const vlmApiKey = visionProvider?.apiKey || mainProvider.apiKey;
      const vlmBaseUrl =
        visionProvider?.apiHost ||
        visionProvider?.defaultApiHost ||
        mainProvider?.apiHost ||
        mainProvider?.defaultApiHost ||
        'https://api.openai.com/v1';
      const vlmModel = visionSelection?.modelId || 'gpt-4o';

      if (!vlmApiKey) {
        throw new Error(t('tools.errors.configApiKey'));
      }

      if (!vlmBaseUrl) {
        throw new Error(t('tools.errors.configApiUrl'));
      }

      // Use pre-converted base64 image content from file selection
      const base64Image = formulaImageBase64;
      const mimeType = formulaImageMimeType;

      // Normalize baseUrl format
      const baseUrlNormalized = vlmBaseUrl.replace(/\/$/, '');
      const apiUrl = baseUrlNormalized.endsWith('/v1')
        ? `${baseUrlNormalized}/chat/completions`
        : `${baseUrlNormalized}/v1/chat/completions`;

      // Call VLM API to recognize formula
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${vlmApiKey}`,
        },
        body: JSON.stringify({
          model: vlmModel,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Please identify the mathematical formula in this image and convert it to LaTeX code.

Requirements:
1. Output only the LaTeX formula code, without any explanation or description.

2. If it's an inline formula, output the formula content directly (no $ symbol needed).

3. If it's a separate formula block, use the \\begin{equation} or \\begin{align} environment.

4. Ensure the LaTeX code can be compiled directly.

5. If there are multiple formulas in the image, each formula should be on a separate line.

Please output the LaTeX code directly:`,
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:${mimeType};base64,${base64Image}`,
                    detail: 'high',
                  },
                },
              ],
            },
          ],
          max_tokens: 2000,
          temperature: 0.1,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`${t('tools.errors.apiRequestFailed')}: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      const latex = data.choices?.[0]?.message?.content?.trim();

      if (latex) {
        setRecognizedLatex(latex);
      } else {
        throw new Error(t('tools.errors.formulaNotRecognized'));
      }
    } catch (error) {
      logger.error('公式识别失败:', error);
      setRecognizedLatex(
        `${t('tools.errors.error')}: ${error instanceof Error ? error.message : t('tools.formula.failed')}`
      );
    } finally {
      setIsRecognizing(false);
    }
  };

  const handleCopyLatex = async () => {
    if (recognizedLatex && !recognizedLatex.startsWith(`${t('tools.errors.error')}: `)) {
      await navigator.clipboard.writeText(recognizedLatex);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleInsertToEditor = () => {
    if (
      recognizedLatex &&
      !recognizedLatex.startsWith(`${t('tools.errors.error')}: `) &&
      activeTabPath
    ) {
      // Dispatch insert event to editor
      window.dispatchEvent(
        new CustomEvent('insert-text', {
          detail: { text: recognizedLatex },
        })
      );
    }
  };

  const handlePdf2Latex = async () => {
    if (!pdfFile || isRunning) return;

    uiService.setAgentState({
      isRunning: true,
      activeTool: 'pdf2latex',
      progress: t('tools.pdf2latexPanel.starting'),
      startTime: Date.now(),
    });
    setResult(null);

    const startTime = Date.now();
    logger.info('PDF 转 LaTeX 开始', { inputFile: pdfFile });
    logger.startTimer('pdf2latex');

    try {
      const res = await getAgentToolsService().runPdf2Latex(pdfFile, {
        concurrent: settings.agents.pdf2latex.maxConcurrentPages,
        timeout: settings.agents.timeout,
      });
      const duration = Date.now() - startTime;

      if (res.success) {
        logger.logWithDuration('info', 'PDF 转 LaTeX 完成', 'pdf2latex', {
          outputPath: res.data?.outputPath,
        });
      } else {
        logger.logWithDuration('warn', 'PDF 转 LaTeX 失败', 'pdf2latex', { message: res.message });
      }

      setResult({
        success: res.success,
        message:
          res.message ||
          (res.success ? t('tools.pdf2latexPanel.success') : t('tools.pdf2latexPanel.failed')),
        outputPath: res.data?.outputPath,
        duration,
      });
    } catch (error) {
      logger.logWithDuration('error', 'PDF 转 LaTeX 异常', 'pdf2latex', error);
      setResult({
        success: false,
        message: error instanceof Error ? error.message : t('tools.pdf2latexPanel.failed'),
      });
    } finally {
      // Reset global state but keep result visible to user
      uiService.setAgentState({
        isRunning: false,
        activeTool: null,
        progress: '',
        startTime: 0,
      });
    }
  };

  const handlePaper2Beamer = async () => {
    if (!texFile || isRunning) return;

    uiService.setAgentState({
      isRunning: true,
      activeTool: 'paper2beamer',
      progress: t('tools.beamerPanel.starting'),
      startTime: Date.now(),
    });
    setResult(null);

    const startTime = Date.now();
    logger.info('论文转 Beamer 开始', {
      inputFile: texFile,
      duration: beamerDuration,
      template: selectedTemplate,
    });
    logger.startTimer('paper2beamer');

    try {
      const res = await getAgentToolsService().runPaper2Beamer(texFile, {
        duration: beamerDuration,
        template: selectedTemplate || undefined,
        timeout: settings.agents.timeout,
      });
      const duration = Date.now() - startTime;

      if (res.success) {
        logger.logWithDuration('info', '论文转 Beamer 完成', 'paper2beamer', {
          outputPath: res.data?.outputPath,
        });
      } else {
        logger.logWithDuration('warn', '论文转 Beamer 失败', 'paper2beamer', {
          message: res.message,
        });
      }

      setResult({
        success: res.success,
        message:
          res.message ||
          (res.success ? t('tools.beamerPanel.success') : t('tools.beamerPanel.failed')),
        outputPath: res.data?.outputPath,
        duration,
      });
    } catch (error) {
      logger.logWithDuration('error', '论文转 Beamer 异常', 'paper2beamer', error);
      setResult({
        success: false,
        message: error instanceof Error ? error.message : t('tools.beamerPanel.failed'),
      });
    } finally {
      uiService.setAgentState({
        isRunning: false,
        activeTool: null,
        progress: '',
        startTime: 0,
      });
    }
  };

  const handleReview = async () => {
    if (!texFile || isRunning) return;

    uiService.setAgentState({
      isRunning: true,
      activeTool: 'review',
      progress: t('tools.reviewerPanel.starting'),
      startTime: Date.now(),
    });
    setResult(null);

    const startTime = Date.now();
    logger.info('AI 审稿开始', { inputFile: texFile });
    logger.startTimer('review');

    try {
      const toolsService = getAgentToolsService();
      let fileToReview = texFile;

      const isRemoteFile = texFile.startsWith('overleaf://');
      if (isRemoteFile) {
        uiService.setAgentState({ message: t('tools.reviewerPanel.downloading') });

        if (!activeTab?.content) {
          throw new Error(t('tools.reviewerPanel.downloadFailed'));
        }

        const fileName = texFile.split(/[/\\]/).pop() || 'paper.tex';
        const tempPath = await toolsService.createTempFile(fileName, activeTab.content);

        if (!tempPath) {
          throw new Error(t('tools.reviewerPanel.tempFileFailed'));
        }

        fileToReview = tempPath;
        logger.info('远程文件已下载到临时文件', { tempPath });
        uiService.setAgentState({ message: t('tools.reviewerPanel.starting') });
      }

      const res = await toolsService.runReviewPaper(fileToReview, settings.agents.timeout);
      const duration = Date.now() - startTime;

      if (res.success) {
        logger.logWithDuration('info', 'AI 审稿完成', 'review', {
          outputPath: res.data?.outputPath,
        });
      } else {
        logger.logWithDuration('warn', 'AI 审稿失败', 'review', { message: res.message });
      }

      setResult({
        success: res.success,
        message: res.success
          ? t('tools.reviewerPanel.success')
          : res.message || t('tools.reviewerPanel.failed'),
        outputPath: res.data?.outputPath,
        duration,
      });
    } catch (error) {
      logger.logWithDuration('error', 'AI 审稿异常', 'review', error);
      setResult({
        success: false,
        message: error instanceof Error ? error.message : t('tools.reviewerPanel.failed'),
      });
    } finally {
      uiService.setAgentState({
        isRunning: false,
        activeTool: null,
        progress: '',
        startTime: 0,
      });
    }
  };

  const handleStop = () => {
    getAgentToolsService().killRunningTask();
    uiService.resetAgentState();
  };

  return (
    <div className="h-full flex flex-col">
      {agentStatus && (
        <div className="p-3 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)] flex-wrap">
            <span>{t('tools.status')}:</span>
            <span
              className={
                agentStatus.pdf2latex ? 'text-[var(--color-success)]' : 'text-[var(--color-error)]'
              }
            >
              pdf2latex {agentStatus.pdf2latex ? '✓' : '✗'}
            </span>
            <span
              className={
                agentStatus.reviewer ? 'text-[var(--color-success)]' : 'text-[var(--color-error)]'
              }
            >
              reviewer {agentStatus.reviewer ? '✓' : '✗'}
            </span>
            <span
              className={
                agentStatus.paper2beamer
                  ? 'text-[var(--color-success)]'
                  : 'text-[var(--color-error)]'
              }
            >
              beamer {agentStatus.paper2beamer ? '✓' : '✗'}
            </span>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        <div className="bg-[var(--color-bg-tertiary)]/50 rounded-lg p-4 border border-[var(--color-border)]">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-[var(--color-warning-muted)] rounded-lg">
              <Calculator size={20} className="text-[var(--color-warning)]" />
            </div>
            <div>
              <h3 className="text-sm font-medium text-[var(--color-text-primary)]">
                {t('tools.formula.title')}
              </h3>
              <p className="text-xs text-[var(--color-text-muted)]">{t('tools.formula.desc')}</p>
            </div>
          </div>

          <div className="space-y-3">
            <button
              onClick={handleSelectFormulaImage}
              className="w-full flex items-center gap-2 px-3 py-2 bg-[var(--color-bg-secondary)] border border-dashed border-[var(--color-border)] rounded-lg text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:border-[var(--color-warning)] transition-colors"
            >
              <Image size={14} />
              <span className="truncate">
                {formulaImage ? formulaImage.split(/[/\\]/).pop() : t('tools.formula.selectImage')}
              </span>
            </button>

            {formulaImagePreview && (
              <div className="relative bg-[var(--color-bg-tertiary)] rounded-lg p-2 flex items-center justify-center">
                <img
                  src={formulaImagePreview}
                  alt={t('tools.formula.preview')}
                  className="max-h-32 max-w-full object-contain rounded"
                />
              </div>
            )}

            <button
              onClick={handleRecognizeFormula}
              disabled={!formulaImage || isRecognizing}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-[var(--color-warning)] hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-all"
            >
              {isRecognizing ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  <span>{t('tools.formula.recognizing')}</span>
                </>
              ) : (
                <>
                  <Calculator size={16} />
                  <span>{t('tools.formula.recognize')}</span>
                </>
              )}
            </button>

            {recognizedLatex && (
              <div
                className={`rounded-lg p-3 ${recognizedLatex.startsWith(`${t('tools.errors.error')}: `) ? 'bg-[var(--color-error-muted)] border border-[var(--color-error)]/30' : 'bg-[var(--color-success-muted)] border border-[var(--color-success)]/30'}`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span
                    className={`text-xs font-medium ${recognizedLatex.startsWith(`${t('tools.errors.error')}: `) ? 'text-[var(--color-error)]' : 'text-[var(--color-success)]'}`}
                  >
                    {recognizedLatex.startsWith(`${t('tools.errors.error')}: `)
                      ? t('tools.formula.failed')
                      : 'LaTeX 代码'}
                  </span>
                  {!recognizedLatex.startsWith(`${t('tools.errors.error')}: `) && (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={handleCopyLatex}
                        className="p-1 hover:bg-[var(--color-bg-hover)] rounded transition-colors"
                        title={t('tools.formula.copy')}
                      >
                        {copied ? (
                          <Check size={14} className="text-[var(--color-success)]" />
                        ) : (
                          <Copy size={14} className="text-[var(--color-text-muted)]" />
                        )}
                      </button>
                      {activeTabPath && (
                        <button
                          onClick={handleInsertToEditor}
                          className="px-2 py-1 text-xs bg-[var(--color-accent-muted)] hover:bg-[var(--color-accent)]/30 text-[var(--color-accent)] rounded transition-colors"
                          title={t('tools.formula.insertToEditor')}
                        >
                          {t('tools.formula.insert')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <pre className="text-xs text-[var(--color-text-secondary)] whitespace-pre-wrap break-all font-mono bg-[var(--color-bg-primary)] rounded p-2 max-h-40 overflow-y-auto">
                  {recognizedLatex}
                </pre>
              </div>
            )}
          </div>
        </div>

        {/* PDF to LaTeX */}
        <div className="bg-[var(--color-bg-tertiary)]/50 rounded-lg p-4 border border-[var(--color-border)]">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-[var(--color-accent-muted)] rounded-lg">
              <FileText size={20} className="text-[var(--color-accent)]" />
            </div>
            <div>
              <h3 className="text-sm font-medium text-[var(--color-text-primary)]">
                {t('tools.pdf2latexPanel.title')}
              </h3>
              <p className="text-xs text-[var(--color-text-muted)]">
                {t('tools.pdf2latexPanel.desc')}
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <button
                onClick={handleSelectPdfFile}
                className="flex-1 flex items-center gap-2 px-3 py-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
              >
                <Upload size={14} />
                <span className="truncate">
                  {pdfFile ? pdfFile.split(/[/\\]/).pop() : t('tools.pdf2latexPanel.selectPdf')}
                </span>
              </button>
            </div>

            <button
              onClick={handlePdf2Latex}
              disabled={!pdfFile || isRunning}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-[var(--color-accent)] hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-all"
            >
              {isRunning && activeTool === 'pdf2latex' ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  <span>{t('tools.pdf2latexPanel.converting')}</span>
                </>
              ) : (
                <>
                  <Play size={16} />
                  <span>{t('tools.pdf2latexPanel.startConvert')}</span>
                </>
              )}
            </button>
          </div>
        </div>

        <div className="bg-[var(--color-bg-tertiary)]/50 rounded-lg p-4 border border-[var(--color-border)]">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-[var(--color-success-muted)] rounded-lg">
              <FileSearch size={20} className="text-[var(--color-success)]" />
            </div>
            <div>
              <h3 className="text-sm font-medium text-[var(--color-text-primary)]">
                {t('tools.reviewerPanel.title')}
              </h3>
              <p className="text-xs text-[var(--color-text-muted)]">
                {t('tools.reviewerPanel.desc')}
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <button
                onClick={handleSelectTexFile}
                className="flex-1 flex items-center gap-2 px-3 py-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
              >
                <FileCode size={14} />
                <span className="truncate">
                  {texFile ? texFile.split(/[/\\]/).pop() : t('tools.reviewerPanel.selectTex')}
                </span>
              </button>
            </div>

            <button
              onClick={handleReview}
              disabled={!texFile || isRunning}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-[var(--color-success)] hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-all"
            >
              {isRunning && activeTool === 'review' ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  <span>{t('tools.reviewerPanel.reviewing')}</span>
                </>
              ) : (
                <>
                  <FileSearch size={16} />
                  <span>{t('tools.reviewerPanel.startReview')}</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Paper to Beamer */}
        <div className="bg-[var(--color-bg-tertiary)]/50 rounded-lg p-4 border border-[var(--color-border)]">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-[var(--color-info-muted)] rounded-lg">
              <Presentation size={20} className="text-[var(--color-info)]" />
            </div>
            <div>
              <h3 className="text-sm font-medium text-[var(--color-text-primary)]">
                {t('tools.beamerPanel.title')}
              </h3>
              <p className="text-xs text-[var(--color-text-muted)]">
                {t('tools.beamerPanel.desc')}
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <button
                onClick={handleSelectTexFile}
                className="flex-1 flex items-center gap-2 px-3 py-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
              >
                <FileCode size={14} />
                <span className="truncate">
                  {texFile ? texFile.split(/[/\\]/).pop() : t('tools.beamerPanel.selectTex')}
                </span>
              </button>
            </div>

            <div className="flex items-center gap-3">
              <span className="text-sm text-[var(--color-text-secondary)]">
                {t('tools.beamerPanel.duration')}:
              </span>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min="5"
                  max="60"
                  step="5"
                  value={beamerDuration}
                  onChange={(e) => setBeamerDuration(Number.parseInt(e.target.value))}
                  className="flex-1 accent-[var(--color-accent)]"
                />
                <span className="text-sm text-[var(--color-text-primary)] w-16 text-right">
                  {beamerDuration} {t('tools.beamerPanel.minutes')}
                </span>
              </div>
            </div>

            {beamerTemplates.length > 0 ? (
              <div>
                <button
                  onClick={() => setShowTemplates(!showTemplates)}
                  className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
                >
                  {showTemplates ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span>
                    {t('tools.beamerPanel.selectTemplate')}{' '}
                    {selectedTemplate && `(${selectedTemplate})`}
                  </span>
                </button>
                <AnimatePresence>
                  {showTemplates && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="mt-2 space-y-1"
                    >
                      <button
                        onClick={() => setSelectedTemplate(null)}
                        className={`w-full text-left px-3 py-1.5 rounded text-sm transition-colors ${
                          !selectedTemplate
                            ? 'bg-[var(--color-accent-muted)] text-[var(--color-accent)]'
                            : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'
                        }`}
                      >
                        {t('tools.beamerPanel.defaultTemplate')}
                      </button>
                      {beamerTemplates.map((template) => (
                        <button
                          key={template}
                          onClick={() => setSelectedTemplate(template)}
                          className={`w-full text-left px-3 py-1.5 rounded text-sm transition-colors ${
                            selectedTemplate === template
                              ? 'bg-[var(--color-accent-muted)] text-[var(--color-accent)]'
                              : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'
                          }`}
                        >
                          {template}
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
                <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                  {t('tools.beamerPanel.templateDir')}
                </p>
              </div>
            ) : (
              <p className="text-xs text-[var(--color-text-muted)]">
                {t('tools.beamerPanel.templateHint')}
              </p>
            )}

            <button
              onClick={handlePaper2Beamer}
              disabled={!texFile || isRunning}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-[var(--color-info)] hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-all"
            >
              {isRunning && activeTool === 'paper2beamer' ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  <span>{t('tools.beamerPanel.generating')}</span>
                </>
              ) : (
                <>
                  <Presentation size={16} />
                  <span>{t('tools.beamerPanel.generate')}</span>
                </>
              )}
            </button>
          </div>
        </div>

        <AnimatePresence>
          {isRunning && progress && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="bg-[var(--color-accent-muted)] border border-[var(--color-accent)]/30 rounded-lg p-4"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-[var(--color-accent)]">{t('tools.progress')}</span>
                <button
                  onClick={handleStop}
                  className="p-1 hover:bg-[var(--color-error-muted)] rounded transition-colors"
                  title={t('tools.stop')}
                >
                  <Square size={14} className="text-[var(--color-error)]" />
                </button>
              </div>
              <p className="text-xs text-[var(--color-text-secondary)] break-all">{progress}</p>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {result && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className={`rounded-lg p-4 ${
                result.success
                  ? 'bg-[var(--color-success-muted)] border border-[var(--color-success)]/30'
                  : 'bg-[var(--color-error-muted)] border border-[var(--color-error)]/30'
              }`}
            >
              <div className="flex items-start gap-3">
                {result.success ? (
                  <CheckCircle size={20} className="text-[var(--color-success)] mt-0.5" />
                ) : (
                  <AlertCircle size={20} className="text-[var(--color-error)] mt-0.5" />
                )}
                <div className="flex-1">
                  <p
                    className={`text-sm ${result.success ? 'text-[var(--color-success)]' : 'text-[var(--color-error)]'}`}
                  >
                    {result.success ? t('tools.execSuccess') : t('tools.failed')}
                  </p>
                  <p className="text-xs text-[var(--color-text-secondary)] mt-1">
                    {result.message}
                  </p>
                  {result.duration && (
                    <p className="text-xs text-[var(--color-text-muted)] mt-1 flex items-center gap-1">
                      <Clock size={12} />
                      {t('tools.duration')} {(result.duration / 1000).toFixed(1)}s
                    </p>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="p-3 border-t border-[var(--color-border)] text-xs text-[var(--color-text-muted)] text-center">
        {t('tools.outputDir')}
      </div>
    </div>
  );
};
