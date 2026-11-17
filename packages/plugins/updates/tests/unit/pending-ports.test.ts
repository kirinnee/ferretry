import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

// Updates keeps no ports-pending/ folder of its own once it has no open line.
const LEDGER = new URL('../../ports-pending/', import.meta.url);
const lines: readonly string[] = existsSync(LEDGER)
  ? readdirSync(LEDGER)
      .filter(name => name.endsWith('.txt'))
      .map(name => readFileSync(new URL(name, LEDGER), 'utf8').trimEnd())
  : [];

/**
 * Updates came back into pending by ruling #28 only for its two unwired app-shell surfaces, What's new and the
 * install-as-app offer. Both are wired now, so Updates has no pending line: FY_UPDATE_CHECK=off is honoured, so that
 * gap stays closed too.
 */
test('Updates has no pending line (FY_UPDATE_CHECK=off is honoured)', () => {
  const reasons: readonly string[] = lines;
  const files = reasons.map(line => /^(?:\[[^\]]+\] )?GAP\(updates\): (app\/lib\/[a-z-]+\.ts) /u.exec(line)?.[1]);
  expect([...files].sort()).toEqual([]);
  expect(reasons.some(line => line.includes('FY_UPDATE_CHECK'))).toBe(false);
});
