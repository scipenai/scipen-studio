/**
 * @file agentPathResolver — single conversion point from SNACA-supplied
 *   paths (workspace-relative, potentially hallucinated) to Studio-absolute
 *   paths suitable for fs IPC.
 *
 * Why this lives alone: any agent → Studio fs data flow MUST pass through
 * here. Splitting the conversion across the bridge / store / UI layers is
 * how `process.cwd()`-based fallback resolution leaks (see commit cf190e7
 * for the incident). Centralizing it means there is exactly one place to
 * audit, one place to add policy (e.g. reject paths outside workspace).
 */

import { getProjectService } from '../core';

/**
 * Resolve an agent-supplied path against the active project root.
 *
 * - Already-absolute input: returned as-is (forward-slash normalized).
 * - Relative input + project open: joined under the project root.
 * - Relative input + no project: returns empty string. Callers that try
 *   to pass this to an fs IPC will be rejected by `safePathSchema`,
 *   producing a clean error instead of a `process.cwd()` resolution.
 */
export function resolveAgentPath(agentRelativeOrAbsolute: string): string {
  if (!agentRelativeOrAbsolute) return '';
  const normalized = agentRelativeOrAbsolute.replace(/\\/g, '/');
  if (isAbsolutePath(normalized)) return normalized;
  const root = getProjectService().projectPath;
  if (!root) return '';
  const normRoot = root.replace(/\\/g, '/');
  return `${normRoot}${normRoot.endsWith('/') ? '' : '/'}${normalized}`;
}

export function isAbsolutePath(p: string): boolean {
  return /^([a-zA-Z]:\/|\/\/|\/)/.test(p);
}

/** Case-insensitive forward-slash-normalized path equality. */
export function sameAbsolutePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}
