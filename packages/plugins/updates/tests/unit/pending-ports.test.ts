import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';

// Updates keeps no ports-pending.json of its own once it has no open line.
const FILE = new URL('../../ports-pending.json', import.meta.url);
const ports: { pendingReasons?: Record<string, readonly string[]> } = existsSync(FILE)
  ? JSON.parse(readFileSync(FILE, 'utf8'))
  : {};

/**
 * Updates came back into pending by ruling #28 only for its two unwired app-shell surfaces, What's new and the
 * install-as-app offer. Both are wired now, so Updates has no pending line: FY_UPDATE_CHECK=off is honoured, so that
 * gap stays closed too.
 */
test('Updates has no pending line (FY_UPDATE_CHECK=off is honoured)', () => {
  const reasons: readonly string[] = ports.pendingReasons?.updates ?? [];
  const files = reasons.map(line => /^(?:\[[^\]]+\] )?GAP\(updates\): (app\/lib\/[a-z-]+\.ts) /u.exec(line)?.[1]);
  expect([...files].sort()).toEqual([]);
  expect(reasons.some(line => line.includes('FY_UPDATE_CHECK'))).toBe(false);
});
