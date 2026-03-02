/**
 * @file Shell environment helpers for GUI-launched apps.
 *
 * GUI applications (Electron) on macOS/Linux don't inherit the user's
 * interactive shell PATH. This module spawns a login shell to capture the
 * real PATH, then merges it into process.env so that spawn/exec can find
 * tools like xelatex, tectonic, typst, etc.
 *
 * On Windows the PATH is inherited correctly from the system environment,
 * so no special handling is needed.
 */

import { execFileSync } from 'child_process';

const SHELL_TIMEOUT_MS = 5_000;

/**
 * Spawn the user's login shell and print its PATH.
 * Returns null on failure so callers can fall back gracefully.
 */
function getShellPath(): string | null {
  if (process.platform === 'win32') return null;

  const shell = process.env.SHELL || '/bin/sh';

  try {
    // -lc: login shell — loads ~/.zprofile, ~/.bash_profile, /etc/profile, etc.
    // zsh login shells also source ~/.zshrc, so PATH set there is captured too.
    const stdout = execFileSync(shell, ['-lc', 'printf "%s" "$PATH"'], {
      encoding: 'utf-8',
      timeout: SHELL_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const result = stdout.trim();
    return result || null;
  } catch {
    return null;
  }
}

/**
 * Merge `shellPath` into `currentPath`, appending any directories that
 * are present in the shell but missing from the current process.
 */
function mergePaths(currentPath: string, shellPath: string): string {
  const currentSet = new Set(currentPath.split(':').filter(Boolean));
  const extra: string[] = [];

  for (const dir of shellPath.split(':')) {
    if (dir && !currentSet.has(dir)) {
      extra.push(dir);
      currentSet.add(dir);
    }
  }

  if (extra.length === 0) return currentPath;
  return currentPath ? `${currentPath}:${extra.join(':')}` : extra.join(':');
}

function buildAugmentedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };

  if (process.platform === 'win32') return env;

  const shellPath = getShellPath();
  if (shellPath) {
    env.PATH = mergePaths(env.PATH || '', shellPath);
  }

  return env;
}

/** Pre-computed augmented environment — safe to reuse across spawn/exec calls. */
export const augmentedEnv = buildAugmentedEnv();
