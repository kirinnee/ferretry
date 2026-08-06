/**
 * The reproducible measurement behind handover row #5.
 *
 *   bun scripts/local/bench-fleet-task-reads.ts
 *   bun scripts/local/bench-fleet-task-reads.ts --boards 96 --latency 12 --samples 3
 *
 * WHAT IT MEASURES. The aggregate task route — `GET /v1/tasks` in
 * `packages/daemon/src/lib/runtime/mounts/tasks.ts` — which is the capability behind `fy task list`
 * when no session is named. That route reads ONE board snapshot file per session, so its cost is
 * the read schedule and nothing else. The PWA's current-session pane is not in scope and never was:
 * it calls `/v1/sessions/:sessionId/tasks`, which reads a single board and contains no fleet walk.
 *
 * WHY BOTH SIDES ARE MEASURED HERE RATHER THAN QUOTED. Row #5 asks for before/after timings, and a
 * number in a document is not a measurement — nobody can tell later whether it still holds. So this
 * script warms BOTH access patterns, then runs them against equivalent fresh fixtures in deterministic
 * alternating pairs:
 *
 *   BEFORE  the pattern `37af20d4` replaced — one awaited `subsystem.board(id).list()` per session,
 *           in index order, reimplemented below because it no longer exists in the tree to call.
 *   AFTER   the real route, dispatched through the production `ApiRouter`/`ApiDispatcher`, which
 *           reaches `readTaskBoardFleet` in `packages/daemon/src/lib/task-boards/fleet-read.ts`.
 *
 * The AFTER path therefore carries routing, authorization and serialization overhead that the
 * BEFORE path does not. That is deliberate and it biases a meaningful overlapping-read result
 * AGAINST the change: the ratio printed is a floor, not a best case. One board or zero injected
 * latency has no overlap to attribute, so those probes report timings but deliberately make no
 * direction claim.
 *
 * SAFE AND OFFLINE. The fixture is `FakeTaskBoard` from the daemon's own unit-test support — an
 * in-memory board with an injected `Bun.sleep` standing in for the file read. Nothing here opens a
 * socket, reads a real state home, or touches `~/.ferretry`. It can be run on any checkout at any
 * time and answers only from what it just measured.
 */
import { NO_GOVERNED_ROUTES_GUARD } from '../../packages/daemon/src/lib/api/capability.ts';
import { ApiDispatcher } from '../../packages/daemon/src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../packages/daemon/src/lib/api/router.ts';
import { type TaskSubsystem, taskRoutes } from '../../packages/daemon/src/lib/runtime/mounts/tasks.ts';
import { request } from '../../packages/daemon/tests/unit/api/support.ts';
import {
  CREDENTIALS,
  FakeTaskBoard,
  human,
  taskSubsystem,
} from '../../packages/daemon/tests/unit/runtime/mounts/support.ts';

/** The commit whose access pattern the BEFORE arm reimplements, so a reader can diff what changed. */
const REFERENCE_COMMIT = '37af20d4';
const REFERENCE_SUBJECT = 'fix(tasks): parallelize fleet board reads (#282)';

const DEFAULTS = { boards: 96, latency: 12, samples: 3 } as const;

const USAGE = 'usage: bun scripts/local/bench-fleet-task-reads.ts [--boards N] [--latency MS] [--samples N]';

/** Refusing beats reporting. A benchmark that prints a number it cannot stand behind is worse than one
 *  that will not run, because the number outlives the run and ends up quoted in a document. */
function refuse(reason: string): never {
  console.error(`❌ ${reason}`);
  console.error(`   ${USAGE}`);
  process.exit(2);
}

/**
 * What each option must be, and why the shape rather than merely the sign is checked.
 *
 * `--samples 0` used to be accepted, and the median of no samples is `NaN`: the script exited 0 and
 * printed `median NaN ms` and `ratio NaN× faster`. A fractional `--boards 2.5` is the same class —
 * `Array.from({ length: 2.5 })` silently gives two boards, so the header would state a fleet size
 * the run did not use. Both are a successful, invalid claim, which is the one outcome a measurement
 * script must never produce.
 */
const OPTIONS = {
  // At least one board: a zero-board fleet times nothing and would report an infinite ratio.
  boards: { integer: true, minimum: 1, unit: 'a whole number of boards, at least 1' },
  // Three alternating pairs keep a single cold run from deciding the claimed direction.
  samples: { integer: true, minimum: 3, unit: 'a whole number of samples, at least 3' },
  // Zero latency is legitimate — it measures the scheduling overhead alone — and a fraction is a
  // real sub-millisecond delay, so only finiteness and sign are constrained here.
  latency: { integer: false, minimum: 0, unit: 'a finite number of milliseconds, 0 or more' },
} as const;

function options(argv: readonly string[]): { boards: number; latency: number; samples: number } {
  const chosen = { ...DEFAULTS } as { boards: number; latency: number; samples: number };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]?.replace(/^--/u, '');
    if (flag !== 'boards' && flag !== 'latency' && flag !== 'samples') refuse(`unknown option ${String(argv[index])}`);
    const raw = argv[index + 1];
    if (raw === undefined) refuse(`--${flag} needs a value`);
    // `Number('')` is 0 and `Number(' 3 ')` is 3, so an empty or padded argument would slip through
    // a bare `Number()` check. Requiring the trimmed text to be non-empty closes both.
    const value = raw.trim() === '' ? Number.NaN : Number(raw);
    const rule = OPTIONS[flag];
    if (!Number.isFinite(value) || value < rule.minimum || (rule.integer && !Number.isInteger(value)))
      refuse(`--${flag} needs ${rule.unit}, got ${JSON.stringify(raw)}`);
    chosen[flag] = value;
  }
  return chosen;
}

/** The short commit this run measured, so the numbers can be re-derived from a known tree. */
function head(): string {
  const shown = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD']);
  return shown.success ? new TextDecoder().decode(shown.stdout).trim() : 'unknown';
}

/** Whether that tree had uncommitted changes, because a benchmark of a dirty tree is not a citation. */
function dirty(): boolean {
  const shown = Bun.spawnSync(['git', 'status', '--porcelain']);
  return shown.success && new TextDecoder().decode(shown.stdout).trim().length > 0;
}

/**
 * A fleet of in-memory boards whose reads cost `latency` milliseconds each.
 *
 * Rebuilt for every warm-up and measured arm, so one arm cannot reuse another's state.
 */
function fleet(boards: number, latency: number): { subsystem: TaskSubsystem; sessionIds: string[] } {
  const sessionIds = Array.from({ length: boards }, (_unused, index) => `s${index}`);
  const built = Object.fromEntries(
    sessionIds.map(sessionId => {
      const board = new FakeTaskBoard(sessionId);
      const list = board.list.bind(board);
      board.list = async () => {
        await Bun.sleep(latency);
        return await list();
      };
      return [sessionId, board];
    }),
  );
  return { subsystem: taskSubsystem({ boards: built, sessionIds }), sessionIds };
}

/**
 * The access pattern before `37af20d4`: every board awaited in turn.
 *
 * Reimplemented rather than imported — the loop was deleted by the change under measurement, so the
 * only honest way to time it is to write it out here beside the thing that replaced it.
 */
async function sequentialFleetRead(subsystem: TaskSubsystem): Promise<number> {
  let rows = 0;
  for (const sessionId of await subsystem.sessionIds()) {
    const read = await subsystem.board(sessionId).list();
    rows += read.entries.length;
  }
  return rows;
}

/**
 * The shipped route, through the real router and dispatcher.
 *
 * `NO_GOVERNED_ROUTES_GUARD` is the same guard the daemon's own route tests construct the dispatcher
 * with. Passing it is not a formality: the argument was missing here until `scripts/local` was added
 * to the root TypeScript project, and JavaScript accepted the short call at run time while the arity
 * error sat unnoticed — the one defect nothing in this repository was checking for.
 */
async function routedFleetRead(subsystem: TaskSubsystem): Promise<number> {
  const dispatch = new ApiDispatcher(new ApiRouter(taskRoutes(subsystem)), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);
  const response = await dispatch.dispatch(request({ path: '/v1/tasks', headers: human }));
  if (response.status !== 200) throw new Error(`the aggregate route answered ${response.status}, not 200`);
  return response.status;
}

type FleetReadArm = (subsystem: TaskSubsystem) => Promise<number>;

/** Time one arm on a new fleet: neither side inherits another side's completed reads. */
async function timeArm(boards: number, latency: number, arm: FleetReadArm): Promise<number> {
  const { subsystem } = fleet(boards, latency);
  const started = performance.now();
  await arm(subsystem);
  return performance.now() - started;
}

/**
 * Warm both paths before collecting data, then alternate their order within each pair.
 *
 * Running all BEFORE samples followed by all AFTER samples made process/JIT warm-up look like an
 * improvement. Alternating is deterministic rather than random, so a cited run can be reproduced,
 * while both arms receive early and late positions instead of one always receiving the cold path.
 */
async function pairedSamples(
  runs: number,
  boards: number,
  latency: number,
): Promise<{ readonly before: number[]; readonly after: number[] }> {
  await timeArm(boards, latency, sequentialFleetRead);
  await timeArm(boards, latency, routedFleetRead);

  const before: number[] = [];
  const after: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    if (run % 2 === 0) {
      before.push(await timeArm(boards, latency, sequentialFleetRead));
      after.push(await timeArm(boards, latency, routedFleetRead));
    } else {
      after.push(await timeArm(boards, latency, routedFleetRead));
      before.push(await timeArm(boards, latency, sequentialFleetRead));
    }
  }
  return { before, after };
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
    : (sorted[middle] as number);
};

const ms = (value: number): string => `${value.toFixed(1)} ms`;

function report(label: string, timings: readonly number[]): number {
  const centre = median(timings);
  console.log(`  ${label.padEnd(38)} median ${ms(centre).padStart(10)}   samples ${timings.map(ms).join(', ')}`);
  return centre;
}

const { boards, latency, samples } = options(Bun.argv.slice(2));

console.log('╭─ fleet task read benchmark ────────────────────────────────────────────────');
console.log(`│ capability   GET /v1/tasks — the aggregate fleet board behind \`fy task list\``);
console.log(`│ file set     packages/daemon/src/lib/runtime/mounts/tasks.ts`);
console.log(`│              packages/daemon/src/lib/task-boards/fleet-read.ts`);
console.log(`│              (packages/daemon/src/adapters/tasks/file-task-store.ts is ONE file read per board)`);
console.log(`│ not in scope /v1/sessions/:sessionId/tasks — the PWA pane reads one board, no fleet walk`);
console.log(`│ fixture      FakeTaskBoard (packages/daemon/tests/unit/runtime/mounts/support.ts), in memory`);
console.log(`│ unit         wall-clock milliseconds, performance.now(), median of the samples`);
console.log(`│ boards       ${boards} sessions, one board each`);
console.log(`│ latency      ${latency} ms injected per board read`);
console.log(`│ samples      ${samples} warmed, alternating pairs; fresh fixture before each arm`);
console.log(`│ measured at  ${head()}${dirty() ? ' (WORKING TREE DIRTY — not a citable run)' : ''}`);
console.log(`│ reference    ${REFERENCE_COMMIT} ${REFERENCE_SUBJECT}`);
console.log('╰────────────────────────────────────────────────────────────────────────────');

const { before, after } = await pairedSamples(samples, boards, latency);

console.log('');
const beforeMedian = report('BEFORE  sequential per-board await', before);
const afterMedian = report('AFTER   real route, bounded fan-out', after);
console.log('');
// A one-board or zero-latency probe has no read overlap to attribute to the pool. Its figures are
// useful scheduling diagnostics, but a direction label would turn timer noise into a product claim.
if (boards === 1 || latency === 0) {
  console.log('  direction INCONCLUSIVE — this probe has no overlapping reads to attribute to the pool.');
  console.log('  Use at least two boards and positive injected latency for a before/after direction claim.');
} else if (afterMedian < beforeMedian) {
  console.log(`  ratio ${(beforeMedian / afterMedian).toFixed(1)}× FASTER after`);
  console.log(`  the BEFORE arm pays no routing, authorization or serialization cost and the AFTER arm`);
  console.log(`  pays all three, so this ratio is a floor.`);
} else if (afterMedian > beforeMedian) {
  console.log(`  ratio ${(afterMedian / beforeMedian).toFixed(1)}× SLOWER after`);
  console.log(`  the AFTER arm alone pays routing, authorization and serialization, which dominates`);
  console.log(`  when there is little read latency to overlap. Compare at a realistic --boards/--latency.`);
} else {
  console.log(`  ratio 1.0× — the two arms measured the same, which at this size means the fixture is`);
  console.log(`  too small to separate them. Raise --boards or --latency.`);
}
