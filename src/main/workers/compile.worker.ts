/**
 * @file LaTeX Compile Worker
 * @description Executes LaTeX compilation in a separate thread to keep main process responsive.
 * Typst compilation lives in the main-process TypstCompiler service.
 */

import { type ChildProcess, spawn } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { parentPort } from 'worker_threads';
import { augmentedEnv } from '../utils/shellEnv';

// ============ Type Definitions ============

interface CompileLatexPayload {
  content: string;
  options?: CompilationOptions;
}

type CleanupPayload = {};

interface AbortPayload {
  abortId: string;
}

type WorkerMessage =
  | { id: string; type: 'compile'; payload: CompileLatexPayload }
  | { id: string; type: 'cleanup'; payload: CleanupPayload }
  | { id: string; type: 'abort'; payload: AbortPayload };

interface WorkerResponse {
  id: string;
  success: boolean;
  data?: CompilationResult;
  error?: string;
}

interface ProgressMessage {
  id: string;
  type: 'progress';
  progress: number;
  message: string;
}

interface LogMessage {
  id: string;
  type: 'log';
  level: 'info' | 'warning' | 'error';
  message: string;
}

interface CompilationOptions {
  engine?: 'tectonic' | 'pdflatex' | 'xelatex' | 'lualatex';
  mainFile?: string;
  projectPath?: string;
}

interface CompilationResult {
  success: boolean;
  pdfPath?: string;
  /** PDF binary data for zero-copy transfer to renderer */
  pdfBuffer?: Uint8Array;
  synctexPath?: string;
  errors?: string[];
  warnings?: string[];
  log?: string;
}

// ============ Worker State ============

const tempDir = path.join(os.tmpdir(), 'scipen-studio-compile');

interface ActiveProcess {
  process: ChildProcess;
  aborted: boolean;
}

const activeProcesses = new Map<string, ActiveProcess>();

function cleanupAllProcesses(): void {
  if (activeProcesses.size === 0) return;

  console.info(`[compile.worker] Cleaning up ${activeProcesses.size} child processes...`);
  for (const [id, entry] of activeProcesses) {
    try {
      // SIGTERM first for graceful exit
      entry.process.kill('SIGTERM');
      console.info(`[compile.worker] Sent SIGTERM to process: ${id}`);
    } catch {
      // Ignore cleanup errors
    }
  }
  activeProcesses.clear();
}

process.on('exit', () => {
  cleanupAllProcesses();
});

process.on('beforeExit', () => {
  cleanupAllProcesses();
});

process.on('SIGTERM', () => {
  console.info('[compile.worker] SIGTERM received');
  cleanupAllProcesses();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.info('[compile.worker] SIGINT received');
  cleanupAllProcesses();
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('[compile.worker] Uncaught exception:', error);
  cleanupAllProcesses();
  process.exit(1);
});

function registerProcess(id: string, proc: ChildProcess): void {
  activeProcesses.set(id, { process: proc, aborted: false });
}

function unregisterProcess(id: string): void {
  activeProcesses.delete(id);
}

function isAborted(id: string): boolean {
  return activeProcesses.get(id)?.aborted ?? false;
}

function abortTask(abortId: string): boolean {
  const entry = activeProcesses.get(abortId);
  if (!entry) {
    // Prefix fallback for family ids — segment-aligned so 'compile-4' never
    // matches 'compile-42-<ts>'. The old second condition
    // (`abortId.startsWith(id.split('-')[0])`) matched literally every task,
    // since all ids start with 'compile-', and could kill an unrelated
    // compilation when the exact id had already finished.
    for (const [id, e] of activeProcesses) {
      if (id.startsWith(`${abortId}-`)) {
        e.aborted = true;
        try {
          e.process.kill('SIGTERM');
          console.info(`[compile.worker] Cancelled task: ${id}`);
          return true;
        } catch {
          return false;
        }
      }
    }
    return false;
  }

  entry.aborted = true;
  try {
    entry.process.kill('SIGTERM');
    console.info(`[compile.worker] Cancelled task: ${abortId}`);
    return true;
  } catch {
    return false;
  }
}

// ============ Utility Functions ============

function sendResponse(response: WorkerResponse): void {
  parentPort?.postMessage(response);
}

function sendProgress(id: string, progress: number, message: string): void {
  const progressMsg: ProgressMessage = {
    id,
    type: 'progress',
    progress,
    message,
  };
  parentPort?.postMessage(progressMsg);
}

function sendLog(id: string, level: 'info' | 'warning' | 'error', message: string): void {
  const logMsg: LogMessage = {
    id,
    type: 'log',
    level,
    message,
  };
  parentPort?.postMessage(logMsg);
}

async function ensureDir(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (_e) {
    // ignore if exists
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content, 'utf-8');
}

async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

async function restoreOriginalContent(
  id: string,
  filePath: string,
  originalContent: string | null,
  expectedContent: string
): Promise<void> {
  if (!originalContent) {
    return;
  }

  try {
    const currentContent = await fs.readFile(filePath, 'utf-8');
    if (currentContent === expectedContent) {
      await writeFile(filePath, originalContent);
      sendLog(id, 'info', 'Compilation failed, file content rolled back');
    } else {
      sendLog(id, 'warning', 'Compilation failed, but file content changed, skipping rollback');
    }
  } catch {
    sendLog(id, 'warning', 'Compilation failed, error during file rollback');
  }
}

// ============ LaTeX Compilation ============

async function compileLatex(
  id: string,
  content: string,
  options: CompilationOptions
): Promise<CompilationResult> {
  const { engine = 'pdflatex', mainFile } = options;

  sendProgress(id, 0, 'Preparing...');
  sendLog(id, 'info', `Engine: ${engine}`);

  if (mainFile && (await pathExists(mainFile))) {
    sendLog(id, 'info', 'Using project file (SyncTeX enabled)');
    return compileProjectFile(id, content, mainFile, engine);
  }

  sendLog(id, 'info', 'Using temp file');
  return compileTempFile(id, content, engine);
}

async function compileProjectFile(
  id: string,
  content: string,
  mainFile: string,
  engine: 'tectonic' | 'pdflatex' | 'xelatex' | 'lualatex'
): Promise<CompilationResult> {
  const workDir = path.dirname(mainFile);
  const baseName = path.basename(mainFile, '.tex');
  const pdfFile = path.join(workDir, `${baseName}.pdf`);
  const originalContent = await readFileSafe(mainFile);

  try {
    sendProgress(id, 10, 'Saving file...');
    await writeFile(mainFile, content);

    sendProgress(id, 20, 'Compiling...');
    let result: CompilationResult;

    if (engine === 'tectonic') {
      result = await runTectonic(id, mainFile, workDir);
    } else {
      result = await runTraditionalLatex(id, mainFile, workDir, engine);
    }

    if (!result.success) {
      await restoreOriginalContent(id, mainFile, originalContent, content);
    }

    if (result.success && (await pathExists(pdfFile))) {
      const synctexFile = path.join(workDir, `${baseName}.synctex.gz`);
      const synctexExists = await pathExists(synctexFile);

      let pdfBuffer: Uint8Array | undefined;
      try {
        const buffer = await fs.readFile(pdfFile);
        pdfBuffer = new Uint8Array(buffer);
      } catch {
        // If read fails, still return path for upstream handling
      }

      return {
        ...result,
        pdfPath: pdfFile,
        pdfBuffer,
        synctexPath: synctexExists ? synctexFile : undefined,
      };
    }

    return result;
  } catch (error) {
    await restoreOriginalContent(id, mainFile, originalContent, content);
    return {
      success: false,
      errors: [error instanceof Error ? error.message : 'Unknown compilation error'],
    };
  }
}

async function compileTempFile(
  id: string,
  content: string,
  engine: 'tectonic' | 'pdflatex' | 'xelatex' | 'lualatex'
): Promise<CompilationResult> {
  const workDir = path.join(tempDir, `compile-${Date.now()}`);
  await ensureDir(workDir);

  const texFile = path.join(workDir, 'document.tex');
  const pdfFile = path.join(workDir, 'document.pdf');

  try {
    sendProgress(id, 10, 'Creating temp file...');
    await writeFile(texFile, content);

    sendProgress(id, 20, 'Compiling...');
    let result: CompilationResult;

    if (engine === 'tectonic') {
      result = await runTectonic(id, texFile, workDir);
    } else {
      result = await runTraditionalLatex(id, texFile, workDir, engine);
    }

    if (result.success && (await pathExists(pdfFile))) {
      let pdfBuffer: Uint8Array | undefined;
      try {
        const buffer = await fs.readFile(pdfFile);
        pdfBuffer = new Uint8Array(buffer);
      } catch {
        // If read fails, still return path for upstream handling
      }

      return {
        ...result,
        pdfPath: pdfFile,
        pdfBuffer,
      };
    }

    return result;
  } catch (error) {
    return {
      success: false,
      errors: [error instanceof Error ? error.message : 'Unknown compilation error'],
    };
  }
}

function runTectonic(id: string, texFile: string, workDir: string): Promise<CompilationResult> {
  return new Promise((resolve) => {
    const args = ['-X', 'compile', '--synctex', '--outdir', workDir, texFile];

    sendLog(id, 'info', `Running: tectonic ${args.join(' ')}`);

    const proc = spawn('tectonic', args, { cwd: workDir, env: augmentedEnv });
    registerProcess(id, proc);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
      const lines = data
        .toString()
        .split('\n')
        .filter((l: string) => l.trim());
      for (const line of lines) {
        sendLog(id, 'info', line);
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      const lines = data
        .toString()
        .split('\n')
        .filter((l: string) => l.trim());
      for (const line of lines) {
        sendLog(id, 'warning', line);
      }
    });

    proc.on('close', (code, signal) => {
      const wasAborted = isAborted(id) || signal === 'SIGTERM';
      unregisterProcess(id);

      if (wasAborted) {
        resolve({
          success: false,
          errors: ['Compilation cancelled'],
          log: stdout + stderr,
        });
        return;
      }

      sendProgress(id, 90, 'Processing results...');
      const log = stdout + stderr;

      if (code === 0) {
        resolve({
          success: true,
          log,
          warnings: parseWarnings(log),
        });
      } else {
        resolve({
          success: false,
          errors: parseErrors(log),
          warnings: parseWarnings(log),
          log,
        });
      }
    });

    proc.on('error', (error: NodeJS.ErrnoException) => {
      unregisterProcess(id);
      if (error.code === 'ENOENT') {
        resolve({
          success: false,
          errors: [
            'Tectonic not found. Please install Tectonic: https://tectonic-typesetting.github.io/',
          ],
        });
      } else {
        resolve({
          success: false,
          errors: [error.message],
        });
      }
    });
  });
}

async function runTraditionalLatex(
  id: string,
  texFile: string,
  workDir: string,
  engine: 'pdflatex' | 'xelatex' | 'lualatex'
): Promise<CompilationResult> {
  // Run twice for proper reference resolution
  for (let i = 0; i < 2; i++) {
    sendProgress(id, 20 + i * 30, `Pass ${i + 1}...`);
    const result = await runTraditionalCompiler(id, texFile, workDir, engine, i + 1);
    if (!result.success && i === 0) {
      return result;
    }
    if (i === 1) {
      return result;
    }
  }

  return { success: false, errors: ['Compilation failed'] };
}

function runTraditionalCompiler(
  id: string,
  texFile: string,
  workDir: string,
  engine: string,
  pass: number
): Promise<CompilationResult> {
  return new Promise((resolve) => {
    const args = [
      '-interaction=nonstopmode',
      '-halt-on-error',
      '-synctex=1',
      '-output-directory',
      workDir,
      texFile,
    ];

    sendLog(id, 'info', `[Pass ${pass}] Running: ${engine}`);

    const proc = spawn(engine, args, { cwd: workDir, env: augmentedEnv });
    const processId = `${id}-pass${pass}`;
    registerProcess(processId, proc);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
      const lines = data
        .toString()
        .split('\n')
        .filter((l: string) => l.trim());
      for (const line of lines) {
        if (!line.startsWith('(') && !line.startsWith(')') && !line.startsWith('[')) {
          sendLog(id, 'info', line);
        }
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      const lines = data
        .toString()
        .split('\n')
        .filter((l: string) => l.trim());
      for (const line of lines) {
        sendLog(id, 'warning', line);
      }
    });

    proc.on('close', (code, signal) => {
      const wasAborted = isAborted(id) || isAborted(processId) || signal === 'SIGTERM';
      unregisterProcess(processId);

      if (wasAborted) {
        resolve({
          success: false,
          errors: ['Compilation cancelled'],
          log: stdout + stderr,
        });
        return;
      }

      const log = stdout + stderr;

      if (code === 0) {
        resolve({
          success: true,
          log,
          warnings: parseWarnings(log),
        });
      } else {
        resolve({
          success: false,
          errors: parseErrors(log),
          warnings: parseWarnings(log),
          log,
        });
      }
    });

    proc.on('error', (error: NodeJS.ErrnoException) => {
      unregisterProcess(processId);
      if (error.code === 'ENOENT') {
        resolve({
          success: false,
          errors: [`${engine} not found. Please install TeX Live or MiKTeX.`],
        });
      } else {
        resolve({
          success: false,
          errors: [error.message],
        });
      }
    });
  });
}

// ============ Log Parsing ============

function parseErrors(log: string): string[] {
  const errors: string[] = [];
  const lines = log.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // LaTeX error format: ! Error message
    if (line.startsWith('!')) {
      let errorMessage = line.substring(1).trim();

      // Heuristic: scan following lines for a line number hint
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const lineMatch = lines[j].match(/^l\.(\d+)\s/);
        if (lineMatch) {
          errorMessage = `Line ${lineMatch[1]}: ${errorMessage}`;
          break;
        }
      }

      errors.push(humanizeError(errorMessage));
    }

    // Tectonic error
    const tectonicMatch = line.match(/^error:\s*(.+)$/i);
    if (tectonicMatch) {
      errors.push(tectonicMatch[1]);
    }
  }

  return errors.length > 0 ? errors : ['Compilation failed with unknown error'];
}

function parseWarnings(log: string): string[] {
  const warnings: string[] = [];
  const lines = log.split('\n');

  for (const line of lines) {
    // LaTeX warning
    const warningMatch = line.match(/^(?:LaTeX|Package|Class)\s+\w*\s*Warning:\s*(.+)$/i);
    if (warningMatch) {
      warnings.push(humanizeWarning(warningMatch[1]));
    }

    // Overfull/Underfull
    const boxMatch = line.match(/^(Overfull|Underfull)\s+\\(hbox|vbox)/);
    if (boxMatch) {
      warnings.push(humanizeWarning(line));
    }
  }

  return warnings;
}

function humanizeError(error: string): string {
  const mappings: Record<string, string> = {
    'Undefined control sequence':
      'Undefined command. Check spelling or ensure the package is loaded.',
    'Missing $ inserted': 'Missing $ symbol. You may have used a math symbol outside math mode.',
    'Missing \\begin{document}': 'Missing \\begin{document}. Check document structure.',
  };

  for (const [pattern, msg] of Object.entries(mappings)) {
    if (error.includes(pattern)) {
      return `${error} — ${msg}`;
    }
  }

  return error;
}

function humanizeWarning(warning: string): string {
  const mappings: Record<string, string> = {
    'Overfull \\hbox': 'Line content too wide, may exceed page margin',
    'Underfull \\hbox': 'Line content too sparse, may cause uneven spacing',
  };

  for (const [pattern, msg] of Object.entries(mappings)) {
    if (warning.includes(pattern)) {
      return msg;
    }
  }

  return warning;
}

// ============ Cleanup ============

async function cleanup(id: string): Promise<void> {
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
    sendResponse({ id, success: true });
  } catch (error) {
    sendResponse({
      id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ============ Message Handling ============

parentPort?.on('message', async (message: WorkerMessage) => {
  const { id, type, payload } = message;

  try {
    switch (type) {
      case 'compile': {
        const result = await compileLatex(id, payload.content, payload.options || {});
        sendProgress(id, 100, result.success ? 'Success' : 'Failed');
        sendResponse({ id, success: true, data: result });
        break;
      }

      case 'cleanup': {
        await cleanup(id);
        break;
      }

      case 'abort': {
        const { abortId } = payload;
        const success = abortTask(abortId);
        sendResponse({
          id,
          success,
          error: success ? undefined : `Task not found: ${abortId}`,
        });
        break;
      }

      default:
        sendResponse({
          id,
          success: false,
          error: `Unknown operation type: ${type}`,
        });
    }
  } catch (error) {
    sendResponse({
      id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

console.info('[compile.worker] Started');
