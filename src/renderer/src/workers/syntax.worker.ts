/**
 * @file syntax.worker.ts - Syntax Check Worker
 * @description Performs syntax diagnostics in Web Worker thread to avoid blocking main thread
 */

// Simplified logging - no output in production
const log = {
  error: (...args: unknown[]) => console.error('[SyntaxWorker]', ...args),
};

interface DiagnosticsRequest {
  type: 'runDiagnostics';
  id: string;
  content: string;
}

interface DiagnosticsResponse {
  type: 'diagnosticsResult';
  id: string;
  markers: SyntaxMarker[];
}

interface SyntaxMarker {
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

interface EnvMatch {
  name: string;
  line: number;
  col: number;
}

/**
 * Extract environment matches from a line
 */
function extractEnvMatches(
  line: string,
  lineIndex: number,
  globalPattern: RegExp,
  extractPattern: RegExp
): EnvMatch[] {
  const matches: EnvMatch[] = [];
  let match: RegExpExecArray | null;

  // Reset regex
  globalPattern.lastIndex = 0;

  while ((match = globalPattern.exec(line)) !== null) {
    const extract = extractPattern.exec(match[0]);
    if (extract) {
      matches.push({
        name: extract[1],
        line: lineIndex,
        col: match.index,
      });
    }
  }

  return matches;
}

/**
 * Create environment marker
 */
function createEnvMarker(
  env: EnvMatch,
  type: 'begin' | 'end',
  severity: 'error' | 'warning'
): SyntaxMarker {
  const envName = env.name;
  const message =
    type === 'begin' ? `未找到匹配的 \\end{${envName}}` : `未找到匹配的 \\begin{${envName}}`;

  // Calculate extra length for command prefix
  const extraLen = type === 'begin' ? 8 : 6; // "\\begin{" or "\\end{"

  return {
    severity,
    message,
    startLineNumber: env.line + 1,
    startColumn: env.col + 1,
    endLineNumber: env.line + 1,
    endColumn: env.col + env.name.length + extraLen,
  };
}

/**
 * Run syntax diagnostics
 */
function runDiagnostics(content: string): SyntaxMarker[] {
  const markers: SyntaxMarker[] = [];
  const lines = content.split('\n');
  const beginEnvs: EnvMatch[] = [];
  const unmatchedEnds: EnvMatch[] = [];

  const BEGIN_PATTERN = /\\begin\{([^}]+)\}/g;
  const END_PATTERN = /\\end\{([^}]+)\}/g;
  const BEGIN_EXTRACT = /\\begin\{([^}]+)\}/;
  const END_EXTRACT = /\\end\{([^}]+)\}/;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];

    // Collect \begin environments
    const begins = extractEnvMatches(line, lineIndex, BEGIN_PATTERN, BEGIN_EXTRACT);
    beginEnvs.push(...begins);

    // Process \end environments: try to match or record as unmatched
    const ends = extractEnvMatches(line, lineIndex, END_PATTERN, END_EXTRACT);
    for (const end of ends) {
      const matchIdx = beginEnvs.findIndex((b) => b.name === end.name);
      if (matchIdx >= 0) {
        beginEnvs.splice(matchIdx, 1); // Matched, remove
      } else {
        unmatchedEnds.push(end); // Unmatched \end
      }
    }

    // Check for unclosed \cite commands
    if (line.includes('\\cite{') && !line.includes('}')) {
      markers.push({
        severity: 'warning',
        message: '可能未闭合的 \\cite 命令',
        startLineNumber: lineIndex + 1,
        startColumn: line.indexOf('\\cite') + 1,
        endLineNumber: lineIndex + 1,
        endColumn: line.length + 1,
      });
    }
  }

  // Generate markers for unmatched environments
  for (const env of beginEnvs) {
    markers.push(createEnvMarker(env, 'begin', 'error'));
  }
  for (const env of unmatchedEnds) {
    markers.push(createEnvMarker(env, 'end', 'error'));
  }

  return markers;
}

// Worker message handling
self.onmessage = (event: MessageEvent<DiagnosticsRequest>) => {
  const { type, id, content } = event.data;

  if (type === 'runDiagnostics') {
    try {
      const markers = runDiagnostics(content);

      const response: DiagnosticsResponse = {
        type: 'diagnosticsResult',
        id,
        markers,
      };

      self.postMessage(response);
    } catch (error) {
      log.error('诊断失败:', error);

      const response: DiagnosticsResponse = {
        type: 'diagnosticsResult',
        id,
        markers: [],
      };

      self.postMessage(response);
    }
  }
};
