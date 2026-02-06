/**
 * @file CompilerProviders.ts - Compiler Provider Implementation
 * @description Provides Provider implementations for LaTeX, Typst, and Overleaf compilers
 * @depends IPC (api.compiler), CompilerRegistry
 */

import { api } from '../../api';
import { createLogger } from '../LogService';
import type { CompileResult, LatexEngine, TypstEngine } from './CompileService';
import type { CompilerOptions, CompilerProvider } from './LanguageFeatureRegistry';

const logger = createLogger('CompilerProviders');

// ====== LaTeX Compiler Provider ======

export class LaTeXCompilerProvider implements CompilerProvider {
  readonly id = 'latex-local';
  readonly name = 'LaTeX (Local)';
  readonly supportedExtensions = ['tex', 'latex', 'ltx'];
  readonly priority = 10;
  readonly isRemote = false;

  async compile(
    filePath: string,
    content: string,
    options: CompilerOptions
  ): Promise<CompileResult> {
    logger.info('Starting local LaTeX compile', {
      engine: options.engine,
      file: filePath,
    });

    const compileOptions: {
      engine?: LatexEngine;
      mainFile?: string;
      projectPath?: string;
    } = {
      engine: options.engine as LatexEngine,
    };

    if (options.mainFile) {
      compileOptions.mainFile = options.mainFile;
    }

    const result = await api.compile.latex(content, compileOptions);

    return {
      success: result.success,
      pdfPath: result.pdfPath,
      synctexPath: result.synctexPath,
      log: result.log,
      errors: result.errors,
      warnings: result.warnings,
      parsedErrors: result.parsedErrors as Array<{ line: number; message: string }> | undefined,
      parsedWarnings: result.parsedWarnings as Array<{ line: number; message: string }> | undefined,
      parsedInfo: result.parsedInfo as Array<{ line: number; message: string }> | undefined,
    };
  }

  canHandle(filePath: string, options?: CompilerOptions): boolean {
    if (options?.engine === 'overleaf') {
      return false;
    }
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    return this.supportedExtensions.includes(ext);
  }
}

// ====== Typst Compiler Provider ======

export class TypstCompilerProvider implements CompilerProvider {
  readonly id = 'typst-local';
  readonly name = 'Typst (Local)';
  readonly supportedExtensions = ['typ'];
  readonly priority = 10;
  readonly isRemote = false;

  async compile(
    filePath: string,
    content: string,
    options: CompilerOptions
  ): Promise<CompileResult> {
    const typstEngine =
      options.engine === 'typst' || options.engine === 'tinymist'
        ? (options.engine as TypstEngine)
        : 'tinymist';

    logger.info('Starting Typst compile', {
      engine: typstEngine,
      file: filePath,
    });

    const compileOptions: {
      engine?: TypstEngine;
      mainFile?: string;
      projectPath?: string;
    } = {
      engine: typstEngine,
    };

    if (options.mainFile) {
      compileOptions.mainFile = options.mainFile;
    }

    const result = await api.compile.typst(content, compileOptions);

    return {
      success: result.success,
      pdfPath: result.pdfPath,
      synctexPath: (result as { synctexPath?: string }).synctexPath,
      log: result.log,
      errors: result.errors,
      warnings: result.warnings,
      parsedErrors: result.parsedErrors as Array<{ line: number; message: string }> | undefined,
      parsedWarnings: result.parsedWarnings as Array<{ line: number; message: string }> | undefined,
      parsedInfo: result.parsedInfo as Array<{ line: number; message: string }> | undefined,
    };
  }
}

// ====== Overleaf Remote Compiler Provider ======

export class OverleafCompilerProvider implements CompilerProvider {
  readonly id = 'overleaf-remote';
  readonly name = 'Overleaf (Remote)';
  readonly supportedExtensions = ['tex', 'latex', 'ltx'];
  readonly priority = 5;
  readonly isRemote = true;

  async compile(
    _filePath: string,
    _content: string,
    options: CompilerOptions
  ): Promise<CompileResult> {
    const overleafConfig = options.overleaf;
    if (!overleafConfig?.projectId) {
      return {
        success: false,
        errors: ['Please configure Overleaf project ID in settings'],
      };
    }

    logger.info('Starting Overleaf compile', {
      projectId: overleafConfig.projectId,
    });

    const loginResult = await api.overleaf.login({
      serverUrl: overleafConfig.serverUrl,
      cookies: overleafConfig.cookies || undefined,
    });

    if (!loginResult.success) {
      throw new Error(`Overleaf login failed: ${loginResult.message}`);
    }

    logger.debug('Overleaf login successful');

    let rootDocId: string | undefined;
    const activeTab = options.activeTab;
    if (activeTab?.isRemote && activeTab?._id && activeTab?.name?.endsWith('.tex')) {
      rootDocId = activeTab._id;
      logger.debug('Using current file as root doc', {
        rootDocId,
        name: activeTab.name,
      });
    }

    const compileOptions: { compiler?: string; rootDocId?: string } = {
      compiler: overleafConfig.remoteCompiler,
    };
    if (rootDocId) {
      compileOptions.rootDocId = rootDocId;
    }

    const compileResult = await api.overleaf.compile(overleafConfig.projectId, compileOptions);

    logger.debug('Overleaf compile result', {
      success: compileResult.success,
      buildId: compileResult.buildId,
      hasPdfBuffer: !!compileResult.pdfBuffer,
    });

    return {
      success: compileResult.success,
      pdfBuffer: compileResult.pdfBuffer,
      log: compileResult.errors?.join('\n'),
      errors: compileResult.errors,
      buildId: compileResult.buildId,
      parsedErrors: compileResult.parsedErrors as
        | Array<{ line: number; message: string }>
        | undefined,
      parsedWarnings: compileResult.parsedWarnings as
        | Array<{ line: number; message: string }>
        | undefined,
      parsedInfo: compileResult.parsedInfo as Array<{ line: number; message: string }> | undefined,
    };
  }

  canHandle(_filePath: string, options?: CompilerOptions): boolean {
    return options?.engine === 'overleaf';
  }
}
