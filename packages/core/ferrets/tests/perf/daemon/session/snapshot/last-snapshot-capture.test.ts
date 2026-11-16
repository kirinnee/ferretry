import { describe, expect, test } from 'bun:test';
import { type Duration, milliseconds } from '@ferretry/std';
import type { Runner, RunnerHandle, RunnerLook } from '../../../../../contract/index.ts';
import { ferretId } from '../../../../../contract/testing/index.ts';
import { LastSnapshotCapture } from '../../../../../daemon/lib/session/snapshot/index.ts';

/** F-0326, the SPEED half: a look that hangs is given up inside 1 s. What is (not) written is unit's. */
const sleep = async (delay: Duration, signal?: AbortSignal): Promise<void> =>
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delay);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    });
  });

describe('F-0326 the last screen a stop keeps (last-snapshot.txt)', () => {
  test('F-0326 a look that hangs is given up after the bound: the capture settles in under 1 s', async () => {
    const capture = new LastSnapshotCapture({
      store: () => ({ write: async () => {} }),
      redaction: { read: async fn => await fn({ text: s => s, cells: grid => grid, lines: lines => lines }) },
      sleep,
      log: { warn: () => {} },
      bound: milliseconds(20),
    });
    const hanging = new Promise<RunnerLook>(() => {});
    const started = Date.now();
    await capture.capture(
      ferretId('mw7bp88g-50e00159'),
      { look: async () => await hanging } as unknown as Runner,
      '%7' as RunnerHandle,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
