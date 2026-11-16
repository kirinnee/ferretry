import { describe, expect, test } from 'bun:test';
import { readMachineTimeZone, withLoginBudget, withMachineTimeZone } from '../../../app/lib/usage-file.ts';
import { boundFor, HOSTILE_TEXTS } from '../../support/hostile-usage-yaml.ts';

// The budget editor reads a planted `usage.yaml` through the shared bounded reader, so the person's tab is never
// stalled. The refusal itself is tests/unit/app/usage-file-bounds.test.ts; this file holds only the time.

describe('usage app: the budget editor answers a hostile usage.yaml promptly', () => {
  for (const [shape, text] of Object.entries(HOSTILE_TEXTS)) {
    test(`usage app readMachineTimeZone, ${shape}`, () => {
      const hostile = text();
      const started = performance.now();
      expect(readMachineTimeZone(hostile)).toBeNull();
      expect(performance.now() - started).toBeLessThan(boundFor(shape));
    });

    test(`usage app withLoginBudget, ${shape}`, () => {
      const hostile = text();
      const started = performance.now();
      expect(withLoginBudget(hostile, 'login-1', undefined)).toBeNull();
      expect(performance.now() - started).toBeLessThan(boundFor(shape));
    });

    test(`usage app withMachineTimeZone, ${shape}`, () => {
      const hostile = text();
      const started = performance.now();
      withMachineTimeZone(hostile, 'UTC');
      expect(performance.now() - started).toBeLessThan(boundFor(shape));
    });
  }
});
