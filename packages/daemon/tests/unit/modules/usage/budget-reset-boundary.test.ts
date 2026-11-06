import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { usageModule } from '../../../../bin/modules/usage.ts';
import { LIFECYCLE, usageNeeds } from './fixture.ts';

/**
 * THE BUDGET SERVICE IS BUILT ON THE LINE THE BUDGETS START (fix round 1 of the extraction).
 *
 * `BudgetService`'s constructor reads the clock and drops every restored hold whose period has already reset. Before
 * the extraction that happened on the `startBudgets` line; building it with the module (earlier in `createSubsystems`)
 * let a period that reset in between keep an expired hold that nothing re-filters. So the service is built BY
 * `jobs.startBudgets`, and this file pins it with a clock that reads before the reset when the module is built and
 * after it when the budgets start.
 */

const RESET_AT_MS = 100;

let home: string;
let realSetInterval: typeof setInterval;
let armed: number[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'usage-reset-boundary-'));
  writeFileSync(
    join(home, 'budget-holds.json'),
    JSON.stringify({
      'claude-a': { period: 'daily', level: 'over_hard', limitUsd: 5, resetsAtMs: RESET_AT_MS, timeZone: 'UTC' },
    }),
  );
  realSetInterval = globalThis.setInterval;
  armed = [];
  // The minute timer is armed for real in production; here it must not outlive the test in the shared unit process.
  globalThis.setInterval = ((_run: () => void, ms: number) => {
    armed.push(ms);
    return { unref: () => undefined };
  }) as unknown as typeof setInterval;
});

afterEach(() => {
  globalThis.setInterval = realSetInterval;
  rmSync(home, { recursive: true, force: true });
});

/** Builds the module with a clock the test moves, starts the budgets, and returns the holds the service then has. */
async function holdsAfter(clockAtBuild: number, clockAtStart: number): Promise<readonly string[] | undefined> {
  let now = clockAtBuild;
  const built = usageModule.build(
    { ...usageNeeds(), paths: { state: home }, millisecondClock: { now: () => now } },
    undefined,
    LIFECYCLE,
  );
  expect(built.provides.budgets.current()).toBeUndefined();
  now = clockAtStart;
  built.jobs.startBudgets();
  // The first tick fails on the fixture's configuration read, which the tick swallows: let it settle.
  await Bun.sleep(0);
  const holds = built.provides.budgets.current()?.holds();
  return holds === undefined ? undefined : Object.keys(holds);
}

describe('usage budgets: a hold restored from disk is judged at the moment the budgets start', () => {
  test('a period that reset between the build and startBudgets keeps no hold', async () => {
    expect(await holdsAfter(RESET_AT_MS - 1, RESET_AT_MS + 1)).toEqual([]);
    expect(armed).toEqual([60_000]);
  });

  test('a period still running when the budgets start keeps its hold', async () => {
    expect(await holdsAfter(RESET_AT_MS - 1, RESET_AT_MS - 1)).toEqual(['claude-a']);
  });
});
