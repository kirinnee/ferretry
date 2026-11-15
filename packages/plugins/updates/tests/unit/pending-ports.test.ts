import { expect, test } from 'bun:test';
import ports from '../../../../../ports-pending.json' with { type: 'json' };

/**
 * Updates is back in pending by ruling #28 only for its one unwired app-shell surface (What's new). The install-as-app
 * offer is wired (a `device.settings` panel and a `background` toast); nothing else may keep Updates in pending:
 * FY_UPDATE_CHECK=off is honoured, so that gap stays closed.
 */
test('Updates is pending only for its one unwired app-shell surface (FY_UPDATE_CHECK=off is honoured)', () => {
  const reasons: readonly string[] = (ports.pendingReasons as Record<string, readonly string[]>).updates ?? [];
  const files = reasons.map(line => /^(?:\[[^\]]+\] )?GAP\(updates\): (app\/lib\/[a-z-]+\.ts) /u.exec(line)?.[1]);
  expect(files).toEqual(['app/lib/changelog.ts']);
  expect(reasons.some(line => line.includes('FY_UPDATE_CHECK'))).toBe(false);
});
