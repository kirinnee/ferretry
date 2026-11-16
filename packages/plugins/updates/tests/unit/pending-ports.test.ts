import { expect, test } from 'bun:test';
import ports from '../../../../../ports-pending.json' with { type: 'json' };

/**
 * Updates is back in pending by ruling #28 only for its two unwired app-shell surfaces (What's new, the install-as-app
 * prompt). Nothing else may keep it there: FY_UPDATE_CHECK=off is honoured, so that gap stays closed.
 */
test('Updates is pending only for its two unwired app-shell surfaces (FY_UPDATE_CHECK=off is honoured)', () => {
  const reasons: readonly string[] = (ports.pendingReasons as Record<string, readonly string[]>).updates ?? [];
  // Lines are ordered by their root-cause bucket (ruling #50), so the files are compared as a set.
  const files = reasons.map(line => /^(?:\[[^\]]+\] )?GAP\(updates\): (app\/lib\/[a-z-]+\.ts) /u.exec(line)?.[1]);
  expect([...files].sort()).toEqual(['app/lib/changelog.ts', 'app/lib/install-prompt.ts']);
  expect(reasons.some(line => line.includes('FY_UPDATE_CHECK'))).toBe(false);
});
