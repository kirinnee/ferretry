import { describe, it } from 'bun:test';
import should from 'should';
import type { FerretId, RunnerHandle } from '../../../../../contract/index.ts';
import { fleetOf as fixtureFleet, MEASURED_TICKS, WARM_TICKS } from '../../../../support/daemon/turn-watch-fleet.ts';

/**
 * RULING #44 condition 3: THE PERF BUDGET of the inline turn watch, on 30 fake panes (u4-report.md, u4-measure/).
 *
 * What is counted is what Ferrets itself runs on the main thread per 2 s tick — the roster, the fold, the pacing, the
 * writer — over the real session store in memory. The pane read is the runner's (`FakeRunner.look` here; Terminals'
 * own parse has its budget beside its parser). Measured on the reference host (32 cores, Bun 1.4.4), best of five
 * rounds of main-thread CPU: idle about 0.07 ms and drawing about 2.1 ms per tick (1.6–1.9 ms in the best round),
 * 180 idle looks a minute (900 unpaced), the longest slice between two hand-backs under 0.1 ms. The transcript tail is
 * the REAL `HarnessTranscript.tail` over a harness whose tail does what Claude's does (a 512 KB window of ~300 records,
 * each JSON-parsed on every read), so a tail read on every look is a cost this test sees (U5 fix1, RULING #27 Q4).
 * About 75% of the drawing figure is that fixture's own JSON parse, which is garbage-heavy, so a collection can land
 * in a round. The idle ceiling is far above its measure; the drawing ceiling is about twice its measure and leaves
 * room for slow-runner noise, not for a regression: the old unpaced look count, a per-tick parse of every document, or
 * one long slice fails.
 */
const FERRETS = 30;
/** Idle: at most one look per pane per 10 s, plus the first look of each pane (today's inline host: 30 per tick). */
const IDLE_LOOKS_CEILING = FERRETS * (MEASURED_TICKS / 5 + 1);
const IDLE_CPU_MS_PER_TICK_CEILING = 3;
const DRAWING_CPU_MS_PER_TICK_CEILING = 4;
/**
 * Each budget is the BEST of five rounds: a collection left over from an earlier test, or one the fixture's own garbage
 * causes, lands in one round; a regression is in every round, and fails.
 */
const ROUNDS = 5;
/** "No single synchronous slice over ~5 ms" (condition 2). */
const SLICE_MS_CEILING = 5;

/** The fixture fleet, with the longest synchronous slice between two hand-backs read off the clock. */
async function fleetOf(turnState: 'your-turn' | 'working') {
  let lastYield = performance.now();
  let longestSliceMs = 0;
  const fleet = await fixtureFleet(turnState, FERRETS, {
    yielding: () => {
      longestSliceMs = Math.max(longestSliceMs, performance.now() - lastYield);
    },
    resumed: () => {
      lastYield = performance.now();
    },
    ticking: () => {
      lastYield = performance.now();
    },
  });
  return {
    ...fleet,
    longestSliceMs: () => longestSliceMs,
    resetSlices: () => {
      longestSliceMs = 0;
    },
  };
}

/** The best round of `ROUNDS`: the least CPU per tick and the shortest longest slice, and every look counted. */
async function bestOf(
  fleet: Awaited<ReturnType<typeof fleetOf>>,
  round: (first: number) => Promise<void>,
): Promise<{ readonly cpuMsPerTick: number; readonly sliceMs: number; readonly looks: number }> {
  let cpuMsPerTick = Number.POSITIVE_INFINITY;
  let sliceMs = Number.POSITIVE_INFINITY;
  const looksBefore = fleet.runner.looked.length;
  for (let index = 0; index < ROUNDS; index += 1) {
    fleet.resetSlices();
    const spent = await cpuMs(async () => await round(WARM_TICKS + index * MEASURED_TICKS));
    cpuMsPerTick = Math.min(cpuMsPerTick, spent / MEASURED_TICKS);
    sliceMs = Math.min(sliceMs, fleet.longestSliceMs());
  }
  return { cpuMsPerTick, sliceMs, looks: fleet.runner.looked.length - looksBefore };
}

/**
 * CPU (user + system) the MAIN THREAD spent running `work`, in ms. RULING #44 budgets what Ferrets runs on the main
 * thread; the whole process would also count the collector's and the compiler's threads. A round is dozens of ms, far
 * above the clock's tick.
 */
async function cpuMs(work: () => Promise<void>): Promise<number> {
  const before = process.threadCpuUsage();
  await work();
  const spent = process.threadCpuUsage(before);
  return (spent.user + spent.system) / 1_000;
}

describe('the inline turn watch budget on 30 panes (RULING #44)', () => {
  it('J-0260 an idle fleet is looked at a fifth as often, under the CPU ceiling per tick, in short slices', async () => {
    // Arrange: thirty quiet panes, each on one unchanging frame.
    const fleet = await fleetOf('your-turn');
    const quiet = () => undefined;
    for (let n = 0; n < WARM_TICKS; n += 1) await fleet.tick(quiet, n);

    // Act
    const best = await bestOf(fleet, async first => {
      for (let n = first; n < first + MEASURED_TICKS; n += 1) await fleet.tick(quiet, n);
    });

    // Assert
    should(best.looks).be.belowOrEqual(IDLE_LOOKS_CEILING * ROUNDS);
    should(best.cpuMsPerTick).be.below(IDLE_CPU_MS_PER_TICK_CEILING);
    should(best.sliceMs).be.below(SLICE_MS_CEILING);
  });

  it('J-0260 an idle fleet whose transcripts did not move reads each tail once, not once per look', async () => {
    // Arrange: thirty quiet panes over thirty transcripts that never change.
    const fleet = await fleetOf('your-turn');
    const quiet = () => undefined;

    // Act: the warm-up ticks and five rounds of a minute.
    for (let n = 0; n < WARM_TICKS; n += 1) await fleet.tick(quiet, n);
    const best = await bestOf(fleet, async first => {
      for (let n = first; n < first + MEASURED_TICKS; n += 1) await fleet.tick(quiet, n);
    });

    // Assert: many looks, one parse of the tail per ferret (the stamp-keyed cache); with no cache every look parses it.
    should(best.looks).be.above(FERRETS);
    should(fleet.harness.reads).be.belowOrEqual(FERRETS);
  });

  it('J-0260 a drawing fleet is looked at every tick, under the CPU ceiling per tick, in short slices', async () => {
    // Arrange: thirty panes redrawing every frame (a spinner and a clock), so none backs off.
    const fleet = await fleetOf('working');
    // The transcripts move every third tick (a turn writing a record every ~6 s), so a third of the looks read afresh.
    const drawing = (handle: RunnerHandle, n: number) => {
      fleet.runner.screens.set(handle, { frame: `w${n}`, working: true, atPrompt: false, permission: false });
      if (n % 3 === 0)
        for (const [ferret, record] of fleet.records)
          if (record.handle === handle) fleet.harness.grow(ferret as FerretId);
    };
    for (let n = 0; n < WARM_TICKS; n += 1) await fleet.tick(drawing, n);

    // Act
    const best = await bestOf(fleet, async first => {
      for (let n = first; n < first + MEASURED_TICKS; n += 1) await fleet.tick(drawing, n);
    });

    // Assert
    should(best.looks).equal(FERRETS * MEASURED_TICKS * ROUNDS);
    // The CPU clock must read something: a drawing round is 60+ ms, so a clock stuck at 0 would pass the ceiling.
    should(best.cpuMsPerTick).be.above(0);
    should(best.cpuMsPerTick).be.below(DRAWING_CPU_MS_PER_TICK_CEILING);
    should(best.sliceMs).be.below(SLICE_MS_CEILING);
    // A tail is parsed when its transcript moved (a third of the looks), never on the two looks between.
    should(fleet.harness.reads).be.belowOrEqual(
      FERRETS * Math.ceil((WARM_TICKS + MEASURED_TICKS * ROUNDS) / 3) + FERRETS,
    );
  });
});
