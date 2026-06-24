/**
 * @file syntax.worker.ts - Syntax check worker
 * @description Runs syntax diagnostics in a Web Worker. Diagnostics are emitted
 *              as i18n keys plus arguments (not pre-translated strings) so the
 *              main thread renders them in the user's current locale. The
 *              worker has no i18next context.
 */

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
  /** i18n key — resolved on the main thread (see `useDiagnostics`). */
  messageKey: string;
  /** Optional interpolation args for the i18n key. */
  messageArgs?: Record<string, string>;
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

function extractEnvMatches(
  line: string,
  lineIndex: number,
  globalPattern: RegExp,
  extractPattern: RegExp
): EnvMatch[] {
  const matches: EnvMatch[] = [];
  let match: RegExpExecArray | null;

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

function createEnvMarker(
  env: EnvMatch,
  type: 'begin' | 'end',
  severity: 'error' | 'warning'
): SyntaxMarker {
  const extraLen = type === 'begin' ? 8 : 6; // "\\begin{" or "\\end{"
  return {
    severity,
    messageKey: type === 'begin' ? 'editor.syntax.unmatchedEnd' : 'editor.syntax.unmatchedBegin',
    messageArgs: { name: env.name },
    startLineNumber: env.line + 1,
    startColumn: env.col + 1,
    endLineNumber: env.line + 1,
    endColumn: env.col + env.name.length + extraLen,
  };
}

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

    const begins = extractEnvMatches(line, lineIndex, BEGIN_PATTERN, BEGIN_EXTRACT);
    beginEnvs.push(...begins);

    const ends = extractEnvMatches(line, lineIndex, END_PATTERN, END_EXTRACT);
    for (const end of ends) {
      const matchIdx = beginEnvs.findIndex((b) => b.name === end.name);
      if (matchIdx >= 0) {
        beginEnvs.splice(matchIdx, 1);
      } else {
        unmatchedEnds.push(end);
      }
    }

    if (line.includes('\\cite{') && !line.includes('}')) {
      markers.push({
        severity: 'warning',
        messageKey: 'editor.syntax.unclosedCite',
        startLineNumber: lineIndex + 1,
        startColumn: line.indexOf('\\cite') + 1,
        endLineNumber: lineIndex + 1,
        endColumn: line.length + 1,
      });
    }
  }

  for (const env of beginEnvs) {
    markers.push(createEnvMarker(env, 'begin', 'error'));
  }
  for (const env of unmatchedEnds) {
    markers.push(createEnvMarker(env, 'end', 'error'));
  }

  return markers;
}

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
      log.error('Diagnostics failed:', error);

      const response: DiagnosticsResponse = {
        type: 'diagnosticsResult',
        id,
        markers: [],
      };

      self.postMessage(response);
    }
  }
};
