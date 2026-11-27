/**
 * Unit tests for the sidecar spawn-failure classification and the terminal
 * `failed` state shape (SidecarState additions in ISnacaSidecarService).
 *
 * The classification is a pure function so the ENOENT → "binary-missing,
 * don't bother retrying" decision is testable without spawning processes.
 */

import { describe, it, expect } from 'vitest';
import { classifySpawnFailure } from '../../../src/main/services/agent/SnacaSidecarService';

const err = (code: string | undefined, message = 'spawn failed'): NodeJS.ErrnoException => {
  const e = new Error(message) as NodeJS.ErrnoException;
  e.code = code;
  return e;
};

describe('classifySpawnFailure', () => {
  it('maps ENOENT to binary-missing (terminal, no retry loop)', () => {
    expect(classifySpawnFailure(err('ENOENT'))).toBe('binary-missing');
  });

  it('maps permission and other spawn errors to crash (retryable path)', () => {
    expect(classifySpawnFailure(err('EACCES'))).toBe('crash');
    expect(classifySpawnFailure(err('EMFILE'))).toBe('crash');
    expect(classifySpawnFailure(err(undefined))).toBe('crash');
  });
});
