import { expect, test } from 'bun:test';
import ports from '../../../../../ports-pending.json' with { type: 'json' };

/**
 * Updates came back into pending by ruling #28 only for its two unwired app-shell surfaces, What's new and the
 * install-as-app offer. Both are wired now, so Updates has no pending line: FY_UPDATE_CHECK=off is honoured, so that
 * gap stays closed too.
 */
test('Updates has no pending line (FY_UPDATE_CHECK=off is honoured)', () => {
  const reasons: readonly string[] = (ports.pendingReasons as Record<string, readonly string[]>).updates ?? [];
  const files = reasons.map(line => /^(?:\[[^\]]+\] )?GAP\(updates\): (app\/lib\/[a-z-]+\.ts) /u.exec(line)?.[1]);
  expect([...files].sort()).toEqual([]);
  expect(reasons.some(line => line.includes('FY_UPDATE_CHECK'))).toBe(false);
});
