/**
 * @file IPC Input Validation
 * @description Path security validation, input sanitization, rate limiting to prevent path traversal and abuse
 * @depends electron.app
 */

import path from 'path';
import { app } from 'electron';

// Allowed base directories for file operations
const ALLOWED_DIRS = new Set<string>();

/**
 * Initialize allowed directories
 * Call this after app is ready
 */
export function initAllowedDirs(): void {
  ALLOWED_DIRS.add(app.getPath('userData'));
  ALLOWED_DIRS.add(app.getPath('documents'));
  ALLOWED_DIRS.add(app.getPath('home'));
  ALLOWED_DIRS.add(app.getPath('temp'));
}

/**
 * Validate that a path is safe for file operations
 */
export function isValidPath(filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string') {
    return false;
  }

  // Normalize the path
  const normalized = path.normalize(filePath);

  // Check for path traversal attempts
  if (normalized.includes('..')) {
    // Allow only if the resolved path is still within allowed directories
    const resolved = path.resolve(normalized);
    return isWithinAllowedDirs(resolved);
  }

  return true;
}

/**
 * Check if a path is within allowed directories
 */
export function isWithinAllowedDirs(filePath: string): boolean {
  const resolved = path.resolve(filePath);

  for (const allowedDir of ALLOWED_DIRS) {
    if (resolved.startsWith(allowedDir)) {
      return true;
    }
  }

  return false;
}

/**
 * Sanitize a string input
 */
export function sanitizeString(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('Invalid input: expected string');
  }

  // Remove null bytes
  return input.replace(/\0/g, '');
}

/**
 * Validate URL format
 */
export function isValidUrl(url: string): boolean {
  if (!url || typeof url !== 'string') {
    return false;
  }

  try {
    const parsed = new URL(url);
    // Only allow http and https
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate API key format (basic check)
 */
export function isValidApiKey(key: string): boolean {
  if (!key || typeof key !== 'string') {
    return false;
  }

  // API keys should be alphanumeric with some special chars, reasonable length
  const pattern = /^[a-zA-Z0-9_-]{20,200}$/;
  return pattern.test(key);
}

/**
 * Sanitize object for logging (remove sensitive data)
 */
export function sanitizeForLogging(obj: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = ['apiKey', 'password', 'token', 'secret', 'key', 'authorization'];
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (sensitiveKeys.some((sk) => key.toLowerCase().includes(sk))) {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      result[key] = sanitizeForLogging(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Rate limiter for IPC calls
 */
class RateLimiter {
  private calls: Map<string, number[]> = new Map();
  private readonly maxCalls: number;
  private readonly windowMs: number;

  constructor(maxCalls = 100, windowMs = 60000) {
    this.maxCalls = maxCalls;
    this.windowMs = windowMs;
  }

  isAllowed(key: string): boolean {
    const now = Date.now();
    const calls = this.calls.get(key) || [];

    // Remove old calls outside the window
    const validCalls = calls.filter((time) => now - time < this.windowMs);

    if (validCalls.length >= this.maxCalls) {
      return false;
    }

    validCalls.push(now);
    this.calls.set(key, validCalls);
    return true;
  }

  reset(key?: string): void {
    if (key) {
      this.calls.delete(key);
    } else {
      this.calls.clear();
    }
  }
}

export const ipcRateLimiter = new RateLimiter(100, 60000);

/**
 * Validate IPC handler input with rate limiting
 */
export function validateIpcCall(channel: string, ..._args: unknown[]): boolean {
  // Rate limiting
  if (!ipcRateLimiter.isAllowed(channel)) {
    console.warn(`[Security] Rate limit exceeded for channel: ${channel}`);
    return false;
  }

  // Channel validation
  if (!channel || typeof channel !== 'string') {
    return false;
  }

  return true;
}
