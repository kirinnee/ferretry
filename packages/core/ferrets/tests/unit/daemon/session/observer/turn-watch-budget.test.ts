import { describe, it } from 'bun:test';
import should from 'should';
import type { FerretId, RunnerHandle } from '../../../../../contract/index.ts';
import { fleetOf, MEASURED_TICKS, WARM_TICKS } from '../../../../support/daemon/turn-watch-fleet.ts';

/**
 * RULING #44 condition 3, the COUNTS of the inline turn watch on a few fake panes: how many looks an idle and a drawing
 * fleet get, and how often a transcript tail is parsed. Its CPU and slice budgets, on 30 panes, are
 * `tests/perf/daemon/session/observer/turn-watch-budget.test.ts`.
 */
const FERRETS = 3;
/** Idle: at most one look per pane per 10 s, plus the first look of each pane (today's inline host: one per tick). */
const IDLE_LOOKS_CEILING = FERRETS * (MEASURED_TICKS / 5 + 1);

const looksOver = async (fleet: Awaited<ReturnType<typeof fleetOf>>, frame: Parameters<typeof fleet.tick>[0]) => {
  for (let n = 0; n < WARM_TICKS; n += 1) await fleet.tick(frame, n);
  const before = fleet.runner.looked.length;
  for (let n = WARM_TICKS; n < WARM_TICKS + MEASURED_TICKS; n += 1) await fleet.tick(frame, n);
  return fleet.runner.looked.length - before;
};

describe('the inline turn watch look counts on 3 panes (RULING #44)', () => {
  it('J-0260 an idle fleet is looked at a fifth as often, and reads each tail once, not once per look', async () => {
    const fleet = await fleetOf('your-turn', FERRETS);
    const looks = await looksOver(fleet, () => undefined);

    should(looks).be.belowOrEqual(IDLE_LOOKS_CEILING);
    should(looks).be.above(FERRETS);
    should(fleet.harness.reads).be.belowOrEqual(FERRETS);
  });

  it('J-0260 a drawing fleet is looked at every tick, and parses a tail only when its transcript moved', async () => {
    const fleet = await fleetOf('working', FERRETS);
    const drawing = (handle: RunnerHandle, n: number) => {
      fleet.runner.screens.set(handle, { frame: `w${n}`, working: true, atPrompt: false, permission: false });
      if (n % 3 === 0)
        for (const [ferret, record] of fleet.records)
          if (record.handle === handle) fleet.harness.grow(ferret as FerretId);
    };
    const looks = await looksOver(fleet, drawing);

    should(looks).equal(FERRETS * MEASURED_TICKS);
    should(fleet.harness.reads).be.belowOrEqual(FERRETS * Math.ceil((WARM_TICKS + MEASURED_TICKS) / 3) + FERRETS);
  });
});
