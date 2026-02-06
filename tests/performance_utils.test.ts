/**
 * @file performance_utils.test.ts
 * @description Tests for performance utilities: Throttler, Delayer, DOMScheduler, EventBuffer
 * @depends vitest, renderer/src/utils
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Delayer, EventBuffer, Throttler } from '../src/renderer/src/utils';
import { DOMSchedulerImpl, SchedulePriority } from '../src/renderer/src/utils/DOMScheduler';

// Mock browser APIs for Node.js test environment
const raf = global.requestAnimationFrame;
const ric = (global as any).requestIdleCallback;
const caf = global.cancelAnimationFrame;
const cic = (global as any).cancelIdleCallback;

describe('Performance Utils', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    global.requestAnimationFrame = (cb) => setTimeout(cb, 16) as any;
    (global as any).requestIdleCallback = (cb: any) =>
      setTimeout(
        () =>
          cb({
            timeRemaining: () => 50,
            didTimeout: false,
          }),
        50
      ) as any;
    global.cancelAnimationFrame = (id) => clearTimeout(id);
    (global as any).cancelIdleCallback = (id: any) => clearTimeout(id);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    global.requestAnimationFrame = raf;
    (global as any).requestIdleCallback = ric;
    global.cancelAnimationFrame = caf;
    (global as any).cancelIdleCallback = cic;
  });

  describe('Throttler', () => {
    it('should throttle requests and only execute the active and latest queued', async () => {
      const throttler = new Throttler();
      const results: string[] = [];

      const factory = (name: string) => async () => {
        results.push(`start ${name}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        results.push(`end ${name}`);
        return name;
      };

      // Start first request
      const p1 = throttler.queue(factory('1'));

      // Queue more requests immediately
      const p2 = throttler.queue(factory('2'));
      const p3 = throttler.queue(factory('3')); // Should supersede 2

      // Fast forward time
      await vi.advanceTimersByTimeAsync(50);

      // p1 should finish, p2 should be skipped, p3 should finish
      await expect(p1).resolves.toBe('1');
      await expect(p3).resolves.toBe('3');

      // Check execution order
      // 1 starts -> 1 ends -> 3 starts (2 skipped) -> 3 ends
      expect(results).toEqual(['start 1', 'end 1', 'start 3', 'end 3']);
    });
  });

  describe('Delayer', () => {
    it('should delay execution and cancel previous triggers', async () => {
      const delayer = new Delayer<string>(100);
      const callback = vi.fn().mockImplementation((val) => val);

      // Trigger multiple times
      delayer.trigger(() => callback('1'));
      delayer.trigger(() => callback('2'));
      const p3 = delayer.trigger(() => callback('3'));

      // Advance time less than delay
      await vi.advanceTimersByTimeAsync(50);
      expect(callback).not.toHaveBeenCalled();

      // Advance time past delay
      await vi.advanceTimersByTimeAsync(60);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith('3');
      await expect(p3).resolves.toBe('3');
    });
  });

  describe('DOMScheduler', () => {
    it('should respect priority order', async () => {
      // Use private constructor via any to test fresh instance
      const scheduler = (DOMSchedulerImpl as any).getInstance();
      // Reset stats/state for test
      scheduler.cancelAll();
      scheduler.resetStats();

      const log: string[] = [];

      scheduler.schedule('low', () => log.push('low'), SchedulePriority.Low);
      scheduler.schedule('high', () => log.push('high'), SchedulePriority.High);
      scheduler.schedule('normal', () => log.push('normal'), SchedulePriority.Normal);
      scheduler.schedule('critical', () => log.push('critical'), SchedulePriority.Critical);

      // Should not have executed yet
      expect(log).toEqual([]);

      // Flush (simulate animation frame)
      await vi.advanceTimersByTimeAsync(20);

      // Check order: Critical -> High -> Normal -> Low
      expect(log).toEqual(['critical', 'high', 'normal', 'low']);
    });

    it('should merge tasks with same key', async () => {
      const scheduler = (DOMSchedulerImpl as any).getInstance();
      scheduler.cancelAll();

      const callback1 = vi.fn();
      const callback2 = vi.fn();

      scheduler.schedule('status', callback1);
      scheduler.schedule('status', callback2);

      await vi.advanceTimersByTimeAsync(20);

      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
    });
  });

  describe('EventBuffer', () => {
    it('should buffer events and flush them in batch', async () => {
      const buffer = new EventBuffer<number>();
      const onFlush = vi.fn();

      buffer.onFlush(onFlush);

      buffer.push(1);
      buffer.push(2);
      buffer.push(3);

      expect(onFlush).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(20);

      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(onFlush).toHaveBeenCalledWith([1, 2, 3]);
    });
  });
});
