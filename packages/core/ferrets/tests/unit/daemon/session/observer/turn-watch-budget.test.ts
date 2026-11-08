import { afterEach, describe, it } from 'bun:test';
import should from 'should';
import type { FerretId, FerretRecord, RunnerHandle } from '../../../../../contract/index.ts';
import { FakeRunner, T0 as RECORD_T0 } from '../../../../../contract/testing/index.ts';
import { buildTurnWatch } from '../../../../../daemon/modules/turn-watch.ts';
import { TURN_WATCH_INTERVAL_MS } from '../../../../../daemon/lib/session/peers/turn.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';
import { memoryStorage, RecordingLog, sessionConfig } from '../../../../support/daemon/storage.ts';

/**
 * RULING #44 condition 3: THE PERF BUDGET of the inline turn watch, on 30 fake panes (u4-report.md, u4-measure/).
 *
 * What is counted is what Ferrets itself runs on the main thread per 2 s tick — the roster, the fold, the pacing, the
 * writer — over the real session store in memory. The pane read is the runner's (`FakeRunner.look` here; Terminals'
 * own parse has its budget beside its parser). Measured on the reference host (32 cores, Bun 1.4.4), three runs: idle
 * 0.23–0.34 ms and drawing 0.35–0.42 ms of CPU per tick, 180 idle looks a minute (900 unpaced), the longest slice
 * between two hand-backs under 0.1 ms. The ceilings below are about ten times that, for a slower CI runner, and leave
 * nothing for a regression: the old unpaced look count, a per-tick parse of every document, or one long slice fails.
 */
const FERRETS = 30;
const WARM_TICKS = 10;
const MEASURED_TICKS = 30; // one minute of 2 s ticks
/** Idle: at most one look per pane per 10 s, plus the first look of each pane (today's inline host: 30 per tick). */
const IDLE_LOOKS_CEILING = FERRETS * (MEASURED_TICKS / 5 + 1);
const IDLE_CPU_MS_PER_TICK_CEILING = 3;
const DRAWING_CPU_MS_PER_TICK_CEILING = 4;
/**
 * Each budget is the BEST of three rounds: CPU is counted for the whole process, so a collection left over from an
 * earlier test lands in one round; a regression is in every round, and fails.
 */
const ROUNDS = 3;
/** "No single synchronous slice over ~5 ms" (condition 2). */
const SLICE_MS_CEILING = 5;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fleetOf(turnState: 'your-turn' | 'working') {
  const { storage } = await memoryStorage({ clock: { now: () => new Date(RECORD_T0).toISOString() } });
  cleanups.push(async () => await storage.close());
  const runner = new FakeRunner();
  const records = new Map<string, FerretRecord>();
  for (let index = 0; index < FERRETS; index += 1) {
    const id = parseSessionId(`budget-${String(index).padStart(2, '0')}`);
    await storage.writeConfig(id, sessionConfig(id));
    await storage.writeState(id, { id, status: 'running', turn: 1, turnState });
    records.set(id, {
      format: 1,
      id: id as unknown as FerretId,
      name: id,
      role: 'lead',
      harness: 'claude-code',
      runner: 'tmux',
      folder: `/work/${id}`,
      state: turnState === 'working' ? 'working' : 'idle',
      handle: runner.adoptable(id as unknown as FerretId),
      createdAt: RECORD_T0,
      stateAt: RECORD_T0,
    } as FerretRecord);
  }
  let nowMs = Date.parse('2026-11-08T10:00:00.000Z');
  let lastYield = performance.now();
  let longestSliceMs = 0;
  const { host } = buildTurnWatch({
    storage,
    tail: { tail: async () => ({ kind: 'unresolved' }) },
    record: ferret => records.get(ferret),
    runner: () => runner,
    turnObserved: async () => undefined,
    clock: { now: () => new Date(nowMs).toISOString() },
    every: () => () => undefined,
    yieldToLoop: async () => {
      const at = performance.now();
      longestSliceMs = Math.max(longestSliceMs, at - lastYield);
      await new Promise<void>(resolve => queueMicrotask(resolve));
      lastYield = performance.now();
    },
    log: new RecordingLog(),
  });
  const tick = async (frame: (handle: RunnerHandle, tick: number) => void, n: number) => {
    for (const record of records.values()) frame(record.handle as RunnerHandle, n);
    lastYield = performance.now();
    await host.turns.run();
    nowMs += TURN_WATCH_INTERVAL_MS;
  };
  return {
    runner,
    tick,
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

/** CPU (user + system) this process spent running `work`, in ms. */
async function cpuMs(work: () => Promise<void>): Promise<number> {
  const before = process.cpuUsage();
  await work();
  const spent = process.cpuUsage(before);
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

  it('J-0260 a drawing fleet is looked at every tick, under the CPU ceiling per tick, in short slices', async () => {
    // Arrange: thirty panes redrawing every frame (a spinner and a clock), so none backs off.
    const fleet = await fleetOf('working');
    const drawing = (handle: RunnerHandle, n: number) =>
      void fleet.runner.screens.set(handle, { frame: `w${n}`, working: true, atPrompt: false, permission: false });
    for (let n = 0; n < WARM_TICKS; n += 1) await fleet.tick(drawing, n);

    // Act
    const best = await bestOf(fleet, async first => {
      for (let n = first; n < first + MEASURED_TICKS; n += 1) await fleet.tick(drawing, n);
    });

    // Assert
    should(best.looks).equal(FERRETS * MEASURED_TICKS * ROUNDS);
    should(best.cpuMsPerTick).be.below(DRAWING_CPU_MS_PER_TICK_CEILING);
    should(best.sliceMs).be.below(SLICE_MS_CEILING);
  });
});
