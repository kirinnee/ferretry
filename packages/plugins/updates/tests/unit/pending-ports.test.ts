import { expect, test } from 'bun:test';
import ports from '../../../../../ports-pending.json' with { type: 'json' };

/**
 * Updates is back in pending by ruling #28 only for its one unwired app-shell surface left (the install-as-app
 * prompt; What's new is wired). Nothing else may keep it there: FY_UPDATE_CHECK=off is honoured, so that gap stays closed.
 */
test('Updates is pending only for its unwired install-as-app prompt (FY_UPDATE_CHECK=off is honoured)', () => {
  const reasons: readonly string[] = (ports.pendingReasons as Record<string, readonly string[]>).updates ?? [];
  // Lines are ordered by their root-cause bucket (ruling #50), so the files are compared as a set.
  const files = reasons.map(line => /^(?:\[[^\]]+\] )?GAP\(updates\): (app\/lib\/[a-z-]+\.ts) /u.exec(line)?.[1]);
  expect([...files].sort()).toEqual(['app/lib/install-prompt.ts']);
  expect(reasons.some(line => line.includes('FY_UPDATE_CHECK'))).toBe(false);
});
