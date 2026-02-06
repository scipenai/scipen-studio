/**
 * @file Worker Utilities
 * @description Unified Worker path resolution and infrastructure tools.
 * @depends electron (for app.isPackaged, process.resourcesPath)
 *
 * Why this module? Ensures Workers can be correctly loaded in both dev and production
 * (packaged) environments, handling path differences between development and asar bundles.
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { app } from 'electron';

// ============ Worker Logging Tools ============

/**
 * @remarks Log level used by worker loggers; warn/error always emit in production.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Creates a Worker logger.
 * In production mode, only outputs warn/error; in dev mode, outputs all levels.
 */
export function createWorkerLogger(workerName: string) {
  const prefix = `[${workerName}]`;
  const isDev = !app.isPackaged;

  return {
    debug: (...args: unknown[]) => {
      if (isDev) console.debug(prefix, ...args);
    },
    info: (...args: unknown[]) => {
      if (isDev) console.info(prefix, ...args);
    },
    warn: (...args: unknown[]) => {
      console.warn(prefix, ...args);
    },
    error: (...args: unknown[]) => {
      console.error(prefix, ...args);
    },
  };
}

// ESM compatibility: get current file directory
const Filename = fileURLToPath(import.meta.url);
const Dirname = path.dirname(Filename);

/**
 * Gets the Worker script path.
 *
 * Handles path differences between dev and production environments:
 * - Dev: out/main/workers/xxx.worker.cjs
 * - Production: resources/app.asar/out/main/workers/xxx.worker.cjs
 *
 * @param workerName Worker name (without extension), e.g., 'compile', 'pdf', 'file'
 * @returns Absolute path to the Worker script.
 */
export function getWorkerPath(workerName: string): string {
  const workerFileName = `${workerName}.worker.cjs`;

  if (app.isPackaged) {
    // Production: Worker is inside app.asar
    return path.join(process.resourcesPath, 'app.asar', 'out', 'main', 'workers', workerFileName);
  } else {
    // Dev: Worker is in out/main/workers/
    // Note: __dirname points to out/main/workers/ after compilation
    return path.join(Dirname, workerFileName);
  }
}

/**
 * Worker auto-restart configuration.
 */
export interface WorkerRestartConfig {
  /** Maximum restart attempts */
  maxRestarts: number;
  /** Restart cooldown time (ms) */
  restartCooldown: number;
  /** Restart count reset time (ms), resets counter after successful run */
  resetAfter: number;
}

/**
 * Default Worker restart configuration.
 */
export const DEFAULT_RESTART_CONFIG: WorkerRestartConfig = {
  maxRestarts: 3,
  restartCooldown: 3000,
  resetAfter: 60000,
};

/**
 * Worker Restart Manager.
 *
 * Tracks Worker crash count and manages restart logic.
 */
export class WorkerRestartManager {
  private restartCount = 0;
  private lastRestartTime = 0;
  private resetTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly workerName: string,
    private readonly config: WorkerRestartConfig = DEFAULT_RESTART_CONFIG
  ) {}

  /**
   * Checks if Worker can be restarted.
   *
   * @returns true if restart is allowed.
   */
  canRestart(): boolean {
    const now = Date.now();

    // Avoid penalizing stable workers after the cooldown window
    if (now - this.lastRestartTime > this.config.resetAfter) {
      this.restartCount = 0;
    }

    return this.restartCount < this.config.maxRestarts;
  }

  /**
   * Records a restart attempt.
   *
   * @returns Wait time (ms) before restart, 0 means immediate restart.
   */
  recordRestart(): number {
    const now = Date.now();
    const timeSinceLastRestart = now - this.lastRestartTime;

    // Backoff to prevent rapid restart loops
    const waitTime = Math.max(0, this.config.restartCooldown - timeSinceLastRestart);

    this.restartCount++;
    this.lastRestartTime = now + waitTime;

    // Only log in dev mode
    if (!app.isPackaged) {
      console.info(
        `[${this.workerName}] Restart attempt ${this.restartCount}/${this.config.maxRestarts}${waitTime > 0 ? `, waiting ${waitTime}ms` : ''}`
      );
    }

    // Reset count after a successful run period
    this.scheduleReset();

    return waitTime;
  }

  /**
   * Resets restart count (called after Worker runs normally).
   */
  reset(): void {
    if (this.restartCount > 0) {
      this.restartCount = 0;
    }
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
  }

  /**
   * Schedules count reset after successful run period.
   */
  private scheduleReset(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
    }

    this.resetTimer = setTimeout(() => {
      this.reset();
    }, this.config.resetAfter);
  }

  /**
   * Gets current restart count.
   */
  getRestartCount(): number {
    return this.restartCount;
  }

  /**
   * Cleans up resources.
   */
  dispose(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
  }
}

/**
 * Creates a Promise with timeout.
 *
 * @param promise Original Promise.
 * @param timeoutMs Timeout duration (ms).
 * @param operationName Operation name (for error message).
 * @returns Promise with timeout.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operationName: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${operationName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

/**
 * Delays execution.
 *
 * @param ms Delay duration (ms).
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
