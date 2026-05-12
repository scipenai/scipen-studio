/**
 * @file EchoSuppressor - Echo suppressor
 * @description Prevents the file watcher from mistaking an OT writeback for an external edit.
 *   Before writing, register {path, contentHash, timestamp}; when the watcher fires, compare
 *   and swallow matches. A generic echo-suppression pattern that keeps local writes from being
 *   treated as remote changes.
 */

import { createHash } from 'crypto';

interface SuppressRecord {
  /** Content hash (MD5 first 8 chars) */
  hash: string;
  /** Registration timestamp */
  registeredAt: number;
}

/** Result of a suppression check */
export interface SuppressCheckResult {
  /** Whether to swallow the event (true = caused by our own writeback, not an external edit) */
  suppressed: boolean;
}

export class EchoSuppressor {
  private records = new Map<string, SuppressRecord>();
  /** Suppression window in ms; entries older than this expire automatically */
  private readonly windowMs: number;
  /** Periodic cleanup of expired records */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(windowMs = 3000) {
    this.windowMs = windowMs;
    // Clean up expired records every 10 seconds
    this.cleanupTimer = setInterval(() => this.cleanup(), 10_000);
  }

  /**
   * Called before writing to disk to register the upcoming content.
   */
  register(filePath: string, content: string | Buffer): void {
    const hash = this.computeHash(content);
    this.records.set(this.normalize(filePath), {
      hash,
      registeredAt: Date.now(),
    });
  }

  /**
   * Called by the watcher to check whether the event should be swallowed.
   * Clears the registration automatically on a hit.
   */
  check(filePath: string, content: string | Buffer): SuppressCheckResult {
    const key = this.normalize(filePath);
    const record = this.records.get(key);

    if (!record) {
      return { suppressed: false };
    }

    const now = Date.now();
    // Expired - drop the registration
    if (now - record.registeredAt > this.windowMs) {
      this.records.delete(key);
      return { suppressed: false };
    }

    const hash = this.computeHash(content);
    if (hash === record.hash) {
      // Hash matches: this event is our own writeback
      this.records.delete(key);
      return { suppressed: true };
    }

    // Hash mismatch: file was modified externally after the writeback
    return { suppressed: false };
  }

  /**
   * Checks whether a path is registered without comparing content.
   */
  isRegistered(filePath: string): boolean {
    const key = this.normalize(filePath);
    const record = this.records.get(key);
    if (!record) return false;
    if (Date.now() - record.registeredAt > this.windowMs) {
      this.records.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Clears the registration for a specific path.
   */
  clear(filePath: string): void {
    this.records.delete(this.normalize(filePath));
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.records.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, record] of this.records) {
      if (now - record.registeredAt > this.windowMs) {
        this.records.delete(key);
      }
    }
  }

  private normalize(filePath: string): string {
    return filePath.replace(/\\/g, '/').toLowerCase();
  }

  private computeHash(content: string | Buffer): string {
    return createHash('md5').update(content).digest('hex').slice(0, 8);
  }
}
