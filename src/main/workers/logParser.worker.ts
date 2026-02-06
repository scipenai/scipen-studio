/**
 * @file logParser.worker - LaTeX Log Parser Worker
 * @description Executes CPU-intensive log parsing in background thread to prevent UI freezes
 * @depends worker_threads
 */

import { parentPort } from 'worker_threads';

// ============ Type Definitions ============

/** Parse request payload */
interface ParsePayload {
  content: string;
}

/** Worker message - currently only supports parse operation */
type WorkerMessage = {
  id: string;
  type: 'parse';
  payload: ParsePayload;
};

interface WorkerResponse {
  id: string;
  success: boolean;
  data?: ParseResult;
  error?: string;
}

/** Parsed log entry */
export interface ParsedLogEntry {
  line: number | null;
  file: string;
  level: 'error' | 'warning' | 'info';
  message: string;
  content: string;
  raw: string;
}

interface ParseResult {
  errors: ParsedLogEntry[];
  warnings: ParsedLogEntry[];
  info: ParsedLogEntry[];
}

// ============ LaTeX Log Parser ============

const LOG_WRAP_LIMIT = 79;
const LATEX_WARNING_REGEX = /^LaTeX(?:3| Font)? Warning: (.*)$/;
const HBOX_WARNING_REGEX = /^(Over|Under)full \\(v|h)box/;
const PACKAGE_WARNING_REGEX = /^((?:Package|Class|Module) \b.+\b Warning:.*)$/;
const LINES_REGEX = /lines? ([0-9]+)/;
const PACKAGE_REGEX = /^(?:Package|Class|Module) (\b.+\b) Warning/;
const FILE_LINE_ERROR_REGEX = /^([./].*):(\d+): (.*)/;

const PARSE_STATE = { normal: 0, error: 1 };

class LogText {
  private lines: string[] = [];
  private row = 0;
  public fileEnd = false;

  constructor(text: string) {
    const normalizedText = text.replace(/(\r\n)|\r/g, '\n');
    const wrappedLines = normalizedText.split('\n');
    this.lines = [wrappedLines[0]];
    for (let i = 1; i < wrappedLines.length; i++) {
      const prevLine = wrappedLines[i - 1];
      const currentLine = wrappedLines[i];
      if (prevLine.length === LOG_WRAP_LIMIT && prevLine.slice(-3) !== '...') {
        this.lines[this.lines.length - 1] += currentLine;
      } else {
        this.lines.push(currentLine);
      }
    }
  }

  nextLine(): string {
    this.row++;
    if (this.row >= this.lines.length) {
      this.fileEnd = true;
      return '';
    }
    return this.lines[this.row];
  }

  linesUpToNextWhitespaceLine(): string[] {
    return this.linesUpToNextMatchingLine(/^ *$/);
  }

  linesUpToNextMatchingLine(match: RegExp): string[] {
    const lines: string[] = [];
    while (true) {
      const nextLine = this.nextLine();
      if (this.fileEnd) break;
      lines.push(nextLine);
      if (nextLine.match(match)) break;
    }
    return lines;
  }
}

function parseLatexLog(text: string): ParseResult {
  const log = new LogText(text);
  const data: ParsedLogEntry[] = [];
  let state = PARSE_STATE.normal;
  let currentLine = '';
  let currentError: ParsedLogEntry = {
    line: null,
    file: '',
    level: 'error',
    message: '',
    content: '',
    raw: '',
  };
  let currentFilePath = '';
  const fileStack: Array<{ path: string }> = [];
  let openParens = 0;

  const consumeFilePath = (): string | false => {
    if (!currentLine.match(/^\/?([^ )]+\/)+/)) return false;
    let endOfFilePath = currentLine.search(/ |\)/);
    while (endOfFilePath !== -1 && currentLine[endOfFilePath] === ' ') {
      const partialPath = currentLine.slice(0, endOfFilePath);
      if (/\.\w+$/.test(partialPath)) break;
      const remainingPath = currentLine.slice(endOfFilePath + 1);
      if (/^\s*["()[\]]/.test(remainingPath)) break;
      const nextEndOfPath = remainingPath.search(/[ "()[\]]/);
      endOfFilePath = nextEndOfPath === -1 ? -1 : endOfFilePath + nextEndOfPath + 1;
    }
    let path: string;
    if (endOfFilePath === -1) {
      path = currentLine;
      currentLine = '';
    } else {
      path = currentLine.slice(0, endOfFilePath);
      currentLine = currentLine.slice(endOfFilePath);
    }
    return path;
  };

  const parseParensForFilenames = (): void => {
    const pos = currentLine.search(/\(|\)/);
    if (pos !== -1) {
      const token = currentLine[pos];
      currentLine = currentLine.slice(pos + 1);
      if (token === '(') {
        const filePath = consumeFilePath();
        if (filePath) {
          currentFilePath = filePath;
          fileStack.push({ path: filePath });
        } else {
          openParens++;
        }
      } else if (token === ')') {
        if (openParens > 0) {
          openParens--;
        } else if (fileStack.length > 1) {
          fileStack.pop();
          currentFilePath = fileStack[fileStack.length - 1].path;
        }
      }
      parseParensForFilenames();
    }
  };

  while (true) {
    currentLine = log.nextLine();
    if (log.fileEnd) break;

    if (state === PARSE_STATE.normal) {
      // Error: starts with !
      if (
        currentLine[0] === '!' &&
        currentLine !== '!  ==> Fatal error occurred, no output PDF file produced!'
      ) {
        state = PARSE_STATE.error;
        currentError = {
          line: null,
          file: currentFilePath,
          level: 'error',
          message: currentLine.slice(2),
          content: '',
          raw: `${currentLine}\n`,
        };
      }
      // File:line error format
      else if (FILE_LINE_ERROR_REGEX.test(currentLine)) {
        state = PARSE_STATE.error;
        const result = currentLine.match(FILE_LINE_ERROR_REGEX) || [];
        currentError = {
          line: Number(result[2]),
          file: result[1],
          level: 'error',
          message: result[3],
          content: '',
          raw: `${currentLine}\n`,
        };
      }
      // Runaway argument
      else if (currentLine.match(/^Runaway argument/)) {
        currentError = {
          line: null,
          file: currentFilePath,
          level: 'error',
          message: currentLine,
          content: '',
          raw: `${currentLine}\n`,
        };
        currentError.content += `${log.linesUpToNextWhitespaceLine().join('\n')}\n`;
        currentError.content += log.linesUpToNextWhitespaceLine().join('\n');
        currentError.raw += currentError.content;
        const lineNo = currentError.raw.match(/l\.([0-9]+)/);
        if (lineNo) currentError.line = Number.parseInt(lineNo[1], 10);
        data.push(currentError);
      }
      // LaTeX Warning
      else if (currentLine.match(LATEX_WARNING_REGEX)) {
        const warningMatch = currentLine.match(LATEX_WARNING_REGEX);
        if (warningMatch) {
          const warning = warningMatch[1];
          const lineMatch = warning.match(LINES_REGEX);
          data.push({
            line: lineMatch ? Number.parseInt(lineMatch[1], 10) : null,
            file: currentFilePath,
            level: 'warning',
            message: warning,
            raw: warning,
            content: '',
          });
        }
      }
      // Hbox warning
      else if (currentLine.match(HBOX_WARNING_REGEX)) {
        const lineMatch = currentLine.match(LINES_REGEX);
        data.push({
          line: lineMatch ? Number.parseInt(lineMatch[1], 10) : null,
          file: currentFilePath,
          level: 'info',
          message: currentLine,
          raw: currentLine,
          content: '',
        });
      }
      // Package warning
      else if (currentLine.match(PACKAGE_WARNING_REGEX)) {
        const warningMatch = currentLine.match(PACKAGE_WARNING_REGEX) || [];
        if (warningMatch.length > 0) {
          const warningLines = [warningMatch[1]];
          let lineMatch = currentLine.match(LINES_REGEX);
          let line = lineMatch ? Number.parseInt(lineMatch[1], 10) : null;
          const packageMatch = currentLine.match(PACKAGE_REGEX) || [];
          const packageName = packageMatch[1];
          const prefixRegex = new RegExp(`(?:\\(${packageName}\\))*[\\s]*(.*)`, 'i');
          while ((currentLine = log.nextLine())) {
            lineMatch = currentLine.match(LINES_REGEX);
            line = lineMatch ? Number.parseInt(lineMatch[1], 10) : line;
            const match = currentLine.match(prefixRegex) || [];
            warningLines.push(match[1]);
          }
          const rawMessage = warningLines.join(' ');
          data.push({
            line,
            file: currentFilePath,
            level: 'warning',
            message: rawMessage,
            raw: rawMessage,
            content: '',
          });
        }
      } else {
        parseParensForFilenames();
      }
    }

    if (state === PARSE_STATE.error) {
      currentError.content += `${log.linesUpToNextMatchingLine(/^l\.[0-9]+/).join('\n')}\n`;
      currentError.content += `${log.linesUpToNextWhitespaceLine().join('\n')}\n`;
      currentError.content += log.linesUpToNextWhitespaceLine().join('\n');
      currentError.raw += currentError.content;
      const lineNo = currentError.raw.match(/l\.([0-9]+)/);
      if (lineNo && currentError.line === null) currentError.line = Number.parseInt(lineNo[1], 10);
      data.push(currentError);
      state = PARSE_STATE.normal;
    }
  }

  // Deduplicate and categorize
  const hashes = new Set<string>();
  const errors: ParsedLogEntry[] = [];
  const warnings: ParsedLogEntry[] = [];
  const info: ParsedLogEntry[] = [];

  for (const item of data) {
    if (hashes.has(item.raw)) continue;
    hashes.add(item.raw);
    if (item.level === 'error') errors.push(item);
    else if (item.level === 'warning') warnings.push(item);
    else info.push(item);
  }

  return { errors, warnings, info };
}

// ============ Helper Functions ============

function sendResponse(response: WorkerResponse): void {
  parentPort?.postMessage(response);
}

// ============ Message Handler ============

parentPort?.on('message', (message: WorkerMessage) => {
  const { id, type, payload } = message;

  try {
    switch (type) {
      case 'parse': {
        const result = parseLatexLog(payload.content);
        sendResponse({ id, success: true, data: result });
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

console.info('[LogParserWorker] Worker started');
