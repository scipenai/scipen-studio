/**
 * @file AgentToolsService.ts - AI Agent Tools Service
 * @description Encapsulates business logic for Agent tools such as PDF2LaTeX, Paper Review, Paper2Beamer
 * @depends IPC (api.agent)
 */

import type {
  AgentAvailability,
  AgentProgress,
  AgentResult,
  Paper2BeamerConfig,
  Pdf2LatexConfig,
} from '../../../../../shared/ipc/types';
import { Disposable, Emitter } from '../../../../../shared/utils';
import { api } from '../../api';

// Re-export types for components
export type { AgentAvailability, AgentProgress, AgentResult, Paper2BeamerConfig, Pdf2LatexConfig };

// Local alias for PDF2LaTeX config
export type PDF2LaTeXConfig = Pdf2LatexConfig;

// ====== Service Implementation ======

class AgentToolsService extends Disposable {
  private static _instance: AgentToolsService | null = null;

  private readonly _onAvailabilityChanged = this._register(new Emitter<AgentAvailability>());
  readonly onAvailabilityChanged = this._onAvailabilityChanged.event;

  private readonly _onProgress = this._register(new Emitter<AgentProgress>());
  readonly onProgress = this._onProgress.event;

  private readonly _onError = this._register(new Emitter<string>());
  readonly onError = this._onError.event;

  private _availability: AgentAvailability = {
    pdf2latex: false,
    reviewer: false,
    paper2beamer: false,
  };
  private _templates: string[] = [];
  private _isRunning = false;
  private _unsubscribeProgress: (() => void) | null = null;

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }

  private constructor() {
    super();
    this._setupProgressListener();
  }

  static getInstance(): AgentToolsService {
    if (!AgentToolsService._instance) {
      AgentToolsService._instance = new AgentToolsService();
    }
    return AgentToolsService._instance;
  }

  private _setupProgressListener(): void {
    this._unsubscribeProgress = api.agent.onProgress((data) => {
      this._onProgress.fire(data);
    });
  }

  override dispose(): void {
    this._unsubscribeProgress?.();
    super.dispose();
  }

  // ====== Availability Check ======

  async checkAvailability(): Promise<{ success: boolean; status?: AgentAvailability }> {
    try {
      this._availability = await api.agent.getAvailable();
      this._onAvailabilityChanged.fire(this._availability);
      return { success: true, status: this._availability };
    } catch (error) {
      console.error('[AgentToolsService] Failed to check availability:', error);
      return { success: false };
    }
  }

  getAvailability(): AgentAvailability {
    return { ...this._availability };
  }

  // ====== Template Management ======

  async loadTemplates(): Promise<string[]> {
    try {
      const result = await api.agent.listTemplates();
      if (result.success && result.data?.templates) {
        this._templates = result.data.templates;
      }
      return this._templates;
    } catch (error) {
      console.error('[AgentToolsService] Failed to load templates:', error);
      return [];
    }
  }

  async getBeamerTemplates(): Promise<string[]> {
    if (this._templates.length === 0) {
      await this.loadTemplates();
    }
    return [...this._templates];
  }

  // ====== File Selection ======

  async selectFile(
    type: 'pdf' | 'tex' | 'image'
  ): Promise<{ path: string; ext?: string; content?: string } | null> {
    try {
      let filters: { name: string; extensions: string[] }[] = [];

      switch (type) {
        case 'pdf':
          filters = [{ name: 'PDF', extensions: ['pdf'] }];
          break;
        case 'tex':
          filters = [{ name: 'LaTeX', extensions: ['tex'] }];
          break;
        case 'image':
          filters = [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] }];
          break;
      }

      const files = await api.file.select({ filters, multiple: false });
      if (files && files.length > 0) {
        const file = files[0];
        const filePath = file.path;
        const ext =
          file.ext.replace('.', '').toLowerCase() || filePath.split('.').pop()?.toLowerCase();
        let content: string | undefined;

        if (type === 'image') {
          const buffer = await api.file.readBinary(filePath);
          content = this.arrayBufferToBase64(buffer);
        }

        return {
          path: filePath,
          ext: ext,
          content,
        };
      }
      return null;
    } catch (error) {
      this._onError.fire(`Failed to select file: ${error}`);
      return null;
    }
  }

  // ====== PDF2LaTeX ======

  async runPdf2Latex(inputFile: string, config?: PDF2LaTeXConfig): Promise<AgentResult> {
    if (this._isRunning) {
      return {
        success: false,
        message: 'Another task is already running',
        error: 'Another task is already running',
      };
    }

    this._isRunning = true;
    try {
      const result = await api.agent.pdf2latex(inputFile, config);
      return result;
    } catch (error) {
      const message = `PDF2LaTeX failed: ${error}`;
      this._onError.fire(message);
      return { success: false, message, error: message };
    } finally {
      this._isRunning = false;
    }
  }

  // ====== Paper Review ======

  async runReviewPaper(inputFile: string, timeout?: number): Promise<AgentResult> {
    if (this._isRunning) {
      return {
        success: false,
        message: 'Another task is already running',
        error: 'Another task is already running',
      };
    }

    this._isRunning = true;
    try {
      const result = await api.agent.reviewPaper(inputFile, timeout);
      return result;
    } catch (error) {
      const message = `Paper review failed: ${error}`;
      this._onError.fire(message);
      return { success: false, message, error: message };
    } finally {
      this._isRunning = false;
    }
  }

  // ====== Paper2Beamer ======

  async runPaper2Beamer(inputFile: string, config?: Paper2BeamerConfig): Promise<AgentResult> {
    if (this._isRunning) {
      return {
        success: false,
        message: 'Another task is already running',
        error: 'Another task is already running',
      };
    }

    this._isRunning = true;
    try {
      const result = await api.agent.paper2beamer(inputFile, config);
      return result;
    } catch (error) {
      const message = `Paper2Beamer failed: ${error}`;
      this._onError.fire(message);
      return { success: false, message, error: message };
    } finally {
      this._isRunning = false;
    }
  }

  // ====== Task Control ======

  killRunningTask(): void {
    api.agent.killCurrentProcess().catch(() => {});
    this._isRunning = false;
  }

  isRunning(): boolean {
    return this._isRunning;
  }

  // ====== Temporary Files ======

  async createTempFile(fileName: string, content: string): Promise<string | null> {
    try {
      return await api.agent.createTempFile(fileName, content);
    } catch (error) {
      this._onError.fire(`Failed to create temp file: ${error}`);
      return null;
    }
  }
}

// ====== Exports ======

let agentToolsService: AgentToolsService | null = null;

export function getAgentToolsService(): AgentToolsService {
  if (!agentToolsService) {
    agentToolsService = AgentToolsService.getInstance();
  }
  return agentToolsService;
}

export function useAgentToolsService(): AgentToolsService {
  return getAgentToolsService();
}
