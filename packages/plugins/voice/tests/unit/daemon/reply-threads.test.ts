import { describe, expect, test } from 'bun:test';
import { replyNativeThreads } from '../../../daemon/lib/reply/catalog.ts';

describe('native reply CPU budget', () => {
  test('uses eight threads on this 32-core machine and scales down on smaller machines', () => {
    expect([1, 2, 3, 4, 8, 12, 16, 24, 32, 64, 128].map(replyNativeThreads)).toEqual([1, 1, 2, 2, 2, 3, 4, 6, 8, 8, 8]);
  });

  test('never takes the last CPU and caps large machines at eight', () => {
    for (let cores = 1; cores <= 256; cores++) {
      const threads = replyNativeThreads(cores);
      expect(Number.isInteger(threads)).toBe(true);
      expect(threads).toBeGreaterThanOrEqual(1);
      expect(threads).toBeLessThanOrEqual(Math.max(1, cores - 1));
      expect(threads).toBeLessThanOrEqual(8);
    }
  });
});
