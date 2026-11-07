import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActivityLedger } from '../../../../src/lib/index.ts';
import { INPUT_REQUEST_SWEEP_MS } from '../../../../src/lib/index.ts';
import { inputRequestsModule } from '../../../../bin/modules/input-requests.ts';
import { inputRequestsNeedsForTest, LIFECYCLE_FOR_TEST } from './fixture.ts';

/**
 * THE ORDER OF THE INPUT-REQUESTS HOUSEKEEPING (fix round 1 of the extraction).
 *
 * Before the extraction `fyd.ts` created the secure-copies interval FIRST and only then the input-requests restore and
 * interval. Two timers of equal delay fire in creation order, and the two sweeps write the same agenda and audit log (a
 * removed session with a waiting phone approval and an expired input request journals in a different order if they
 * swap), so the module must not start them while it is built. The boot trace records only `setInterval 15000`, not whose
 * callback it was, so this file names the callbacks.
 */

/** A ledger that records only the NAME of each activity as it is run, running nothing. */
function recordingLedger(log: string[]): ActivityLedger {
  return {
    run: async (name: string) => {
      log.push(`run ${name}`);
    },
  } as unknown as ActivityLedger;
}

describe('input-requests housekeeping order', () => {
  test('build starts only the phone-approvals restore; the sweep and its restore wait for startInputHousekeeping', () => {
    const log: string[] = [];
    const realSetInterval = globalThis.setInterval;
    const intervals: Array<{ readonly callback: () => void; readonly ms: number }> = [];
    globalThis.setInterval = ((callback: () => void, ms: number) => {
      intervals.push({ callback, ms });
      log.push(`setInterval ${String(ms)}`);
      return { unref: () => undefined };
    }) as unknown as typeof setInterval;
    try {
      const built = inputRequestsModule.build(
        { ...inputRequestsNeedsForTest(), activities: recordingLedger(log) },
        undefined,
        LIFECYCLE_FOR_TEST,
      );
      // Constructing the module has armed NO timer and has not touched input requests.
      expect(log).toEqual(['run phone-approvals-restore']);
      expect(intervals).toEqual([]);

      built.provides.startInputHousekeeping();

      // Restore first, then the interval; and the interval's callback is the `input-requests` sweep.
      expect(log).toEqual([
        'run phone-approvals-restore',
        'run input-requests-restore',
        `setInterval ${INPUT_REQUEST_SWEEP_MS}`,
      ]);
      expect(intervals.map(each => each.ms)).toEqual([INPUT_REQUEST_SWEEP_MS]);
      intervals[0]?.callback();
      expect(log.at(-1)).toBe('run input-requests');
    } finally {
      globalThis.setInterval = realSetInterval;
    }
  });

  test('fyd.ts starts it immediately after the secure-copies interval, which follows the login recipes', () => {
    const source = readFileSync(join(import.meta.dir, '../../../../bin/fyd.ts'), 'utf8');
    const calls = [...source.matchAll(/\bstartInputHousekeeping\(\);/g)];
    expect(calls).toHaveLength(1);
    const built = source.indexOf('inputRequestsModule.build(');
    const recipes = source.indexOf('new LoginRecipeService(');
    const secure = source.indexOf("asActivity(activities, 'secure-copies'");
    const start = calls[0]?.index ?? -1;
    expect(built).toBeGreaterThan(-1);
    expect(built).toBeLessThan(recipes);
    expect(recipes).toBeLessThan(secure);
    expect(secure).toBeLessThan(start);
    // Immediately: only the end of the secure-copies interval and a comment lie between them.
    const between = source.slice(secure, start);
    expect(
      between.match(/INPUT_REQUEST_SWEEP_MS,\n\s*\)\.unref\(\);\n(?:\s*\/\/[^\n]*\n)*\s*$/) ?? undefined,
    ).not.toBeUndefined();
  });
});
