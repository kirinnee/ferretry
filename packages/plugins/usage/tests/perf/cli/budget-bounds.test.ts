import { describe, expect, test } from 'bun:test';
import { BudgetEditError, budgetInFile, withLoginBudget, withTimeZone } from '../../../cli/lib/budget.ts';
import { boundFor, HOSTILE_TEXTS } from '../../support/hostile-usage-yaml.ts';

// `fy login budget` reads a planted `usage.yaml` through the shared bounded reader, so the command finishes at once.
// The refusal's wording is tests/unit/cli/budget-bounds.test.ts; this file holds only the time.

describe('usage cli: a hostile usage.yaml is refused promptly', () => {
  for (const [shape, text] of Object.entries(HOSTILE_TEXTS)) {
    test(`usage cli budgetInFile, ${shape}`, () => {
      const hostile = text();
      const started = performance.now();
      expect(budgetInFile(hostile, 'login-1')).toBeNull();
      expect(performance.now() - started).toBeLessThan(boundFor(shape));
    });

    test(`usage cli withLoginBudget, ${shape}`, () => {
      const hostile = text();
      const started = performance.now();
      expect(() => withLoginBudget(hostile, 'login-1', undefined)).toThrow(BudgetEditError);
      expect(performance.now() - started).toBeLessThan(boundFor(shape));
    });

    test(`usage cli withTimeZone, ${shape}`, () => {
      const hostile = text();
      const started = performance.now();
      try {
        withTimeZone(hostile, 'UTC');
      } catch {
        // a refusal is the answer; only its promptness is measured here
      }
      expect(performance.now() - started).toBeLessThan(boundFor(shape));
    });
  }
});
