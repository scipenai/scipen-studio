/**
 * @file ChatContextBuilder — snapshots renderer-side editor state into a
 *   `ChatContext` payload for `agent.sendChat`.
 *
 * Stateless pure function: read editor / UI / settings / recent-edits
 * services once at call time. Position fields are converted from Monaco
 * 1-based to protocol 0-based.
 *
 * Populated:
 *   - active_file: path / language / cursor / selection / dirty
 *   - open_tabs: all tabs with dirty flag
 *   - project: { type, main_file?, engine? }
 *   - diagnostics: latest compile errors (≤50)
 *   - recent_edits: tail of `RecentEditsTracker` (≤20)
 *   - project_intel: markdown blob from `ChatContextIntelBuilder`
 *
 * Not yet populated (later phases): mentions, active_file.visible_range.
 */

import { truncateToBytes } from '../../../../../shared/utils/text';
import { getEditorService, getProjectService, getSettingsService, getUIService } from '../core';
import { recentEditsTracker } from './RecentEditsTracker';
import { buildProjectIntel } from './ChatContextIntelBuilder';
import type {
  ChatContext,
  DiagnosticItem,
  OpenTab,
  ProjectMeta,
  ProjectType,
  RecentEdit,
} from './AgentClientService';

const DIAGNOSTICS_CAP = 50;
const RECENT_EDITS_CAP = 20;
// 选区文本进入每轮 system_prompt,大段选区不设限会逐轮翻倍撑爆上下文。
const SELECTION_TEXT_MAX_BYTES = 4096;

/**
 * Build a `ChatContext` from the current editor + UI state. Called at send
 * time so the LLM sees the most up-to-date view of what the user is editing.
 */
export function buildChatContext(): ChatContext {
  const editor = getEditorService();
  const project = getProjectService();
  const ui = getUIService();
  const settings = getSettingsService().getSettings();

  const ctx: ChatContext = {};
  const projectPath = project.projectPath;
  const tabs = editor.tabs;
  const activeTab = editor.activeTab;

  // ---- active_file ----
  if (activeTab) {
    const cursor = editor.cursorPosition; // 1-based
    const sel = editor.selection; // 1-based, or null

    ctx.active_file = {
      path: toRelative(activeTab.path, projectPath),
      language: activeTab.language || inferLanguage(activeTab.path) || 'plaintext',
      cursor: { line: Math.max(0, cursor.line - 1), column: Math.max(0, cursor.column - 1) },
      dirty: activeTab.isDirty,
    };

    if (sel && (sel.startLine !== sel.endLine || sel.startColumn !== sel.endColumn)) {
      const range = {
        start: { line: Math.max(0, sel.startLine - 1), column: Math.max(0, sel.startColumn - 1) },
        end: { line: Math.max(0, sel.endLine - 1), column: Math.max(0, sel.endColumn - 1) },
      };
      ctx.active_file.selection = {
        range,
        text: truncateToBytes(
          extractSelectionText(activeTab.content, sel),
          SELECTION_TEXT_MAX_BYTES
        ),
      };
    }
  }

  // ---- open_tabs ----
  if (tabs.length > 0) {
    const open_tabs: OpenTab[] = tabs.map((t) => ({
      path: toRelative(t.path, projectPath),
      dirty: t.isDirty,
    }));
    ctx.open_tabs = open_tabs;
  }

  // ---- project meta ----
  const projectType = inferProjectType(
    activeTab?.path,
    tabs.map((t) => t.path)
  );
  if (projectType) {
    const meta: ProjectMeta = { type: projectType };
    const main = pickMainFile(
      tabs.map((t) => t.path),
      projectType,
      projectPath
    );
    if (main) meta.main_file = main;
    const engine = pickEngine(projectType, settings.compiler);
    if (engine) meta.engine = engine;
    ctx.project = meta;
  }

  // ---- diagnostics ----
  const compileResult = ui.compilationResult;
  if (compileResult?.parsedErrors && compileResult.parsedErrors.length > 0) {
    const diagnostics: DiagnosticItem[] = [];
    for (const err of compileResult.parsedErrors.slice(0, DIAGNOSTICS_CAP)) {
      const path = err.file ? toRelative(err.file, projectPath) : '';
      if (!path) continue;
      const item: DiagnosticItem = {
        path,
        severity: err.level === 'warning' ? 'warning' : err.level === 'info' ? 'info' : 'error',
        message: err.message,
      };
      if (typeof err.line === 'number' && err.line > 0) {
        const ln = Math.max(0, err.line - 1);
        item.range = {
          start: { line: ln, column: 0 },
          end: { line: ln, column: 0 },
        };
      }
      diagnostics.push(item);
    }
    if (diagnostics.length > 0) {
      ctx.diagnostics = diagnostics;
    }
  }

  // ---- recent_edits ----
  const edits = recentEditsTracker.snapshot(RECENT_EDITS_CAP);
  if (edits.length > 0) {
    const recent: RecentEdit[] = edits.map((e) => ({
      path: e.path,
      ts: e.ts,
      summary: e.summary,
    }));
    ctx.recent_edits = recent;
  }

  // ---- project_intel ----
  if (activeTab && ctx.active_file) {
    const intel = buildProjectIntel({
      activeFilePath: activeTab.path,
      activeFileContent: activeTab.content,
      cursorLine: ctx.active_file.cursor?.line ?? 0,
      language: ctx.active_file.language,
      settings: { compiler: settings.compiler },
      lastCompile: compileResult
        ? {
            success: Boolean(compileResult.success),
            errorCount: compileResult.parsedErrors?.length ?? compileResult.errors?.length ?? 0,
            warningCount:
              compileResult.parsedWarnings?.length ?? compileResult.warnings?.length ?? 0,
            durationMs: compileResult.time,
          }
        : null,
    });
    if (intel) ctx.project_intel = intel;
  }

  // ---- 焦点对象身份(易失,表达用户当前注意力)----
  const zoteroItemKey = ui.zoteroPdf?.itemKey;
  if (zoteroItemKey) ctx.active_zotero_item = zoteroItemKey;
  const mdSection = ui.currentMarkdownSection;
  if (mdSection) ctx.markdown_section = mdSection;

  return ctx;
}

// ============ Helpers ============

function toRelative(absPath: string, projectPath: string | null): string {
  const normalizedAbs = normalize(absPath);
  if (!projectPath) return normalizedAbs;
  const normalizedRoot = normalize(projectPath);
  if (normalizedAbs === normalizedRoot) return '';
  const withSep = normalizedRoot.endsWith('/') ? normalizedRoot : normalizedRoot + '/';
  return normalizedAbs.startsWith(withSep) ? normalizedAbs.slice(withSep.length) : normalizedAbs;
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/');
}

function inferLanguage(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (lower.endsWith('.tex') || lower.endsWith('.ltx')) return 'latex';
  if (lower.endsWith('.typ')) return 'typst';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.bib')) return 'bibtex';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  if (lower.endsWith('.txt')) return 'plaintext';
  return undefined;
}

function inferProjectType(activePath: string | undefined, allPaths: string[]): ProjectType | null {
  const candidates = activePath ? [activePath, ...allPaths] : allPaths;
  let hasLatex = false;
  let hasTypst = false;
  for (const p of candidates) {
    const l = p.toLowerCase();
    if (l.endsWith('.tex') || l.endsWith('.ltx')) hasLatex = true;
    else if (l.endsWith('.typ')) hasTypst = true;
  }
  if (hasLatex && hasTypst) return 'mixed';
  if (hasLatex) return 'latex';
  if (hasTypst) return 'typst';
  return null;
}

/**
 * Heuristic: prefer a tab literally named `main.tex` / `main.typ`. Else the
 * first tab whose extension matches the project type. Result is project-
 * relative for consistency with `open_tabs`.
 */
function pickMainFile(
  allPaths: string[],
  projectType: ProjectType,
  projectPath: string | null
): string | undefined {
  const exts = projectType === 'typst' ? ['.typ'] : ['.tex', '.ltx'];
  const explicit = allPaths.find((p) => {
    const base = p.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
    return base === 'main.tex' || base === 'main.ltx' || base === 'main.typ';
  });
  if (explicit) return toRelative(explicit, projectPath);
  const firstMatch = allPaths.find((p) => exts.some((e) => p.toLowerCase().endsWith(e)));
  return firstMatch ? toRelative(firstMatch, projectPath) : undefined;
}

function pickEngine(
  projectType: ProjectType,
  compiler: { engine?: string; typstEngine?: string }
): string | undefined {
  if (projectType === 'typst') return compiler.typstEngine ?? undefined;
  // latex / mixed
  return compiler.engine ?? undefined;
}

function extractSelectionText(
  content: string,
  sel: { startLine: number; startColumn: number; endLine: number; endColumn: number }
): string {
  // Monaco columns are 1-based and exclusive on `endColumn` (caret-style).
  if (!content) return '';
  const lines = content.split('\n');
  const startLine = sel.startLine - 1;
  const endLine = sel.endLine - 1;
  if (startLine < 0 || startLine >= lines.length) return '';
  if (startLine === endLine) {
    const line = lines[startLine] ?? '';
    return line.slice(sel.startColumn - 1, sel.endColumn - 1);
  }
  const out: string[] = [];
  out.push((lines[startLine] ?? '').slice(sel.startColumn - 1));
  for (let i = startLine + 1; i < endLine && i < lines.length; i++) {
    out.push(lines[i]);
  }
  if (endLine < lines.length) {
    out.push((lines[endLine] ?? '').slice(0, sel.endColumn - 1));
  }
  return out.join('\n');
}
