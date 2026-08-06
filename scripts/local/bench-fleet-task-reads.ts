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
 * script runs BOTH access patterns against the same fixture in the same interpreter, in one go:
 *
 *   BEFORE  the pattern `37af20d4` replaced — one awaited `subsystem.board(id).list()` per session,
 *           in index order, reimplemented below because it no longer exists in the tree to call.
 *   AFTER   the real route, dispatched through the production `ApiRouter`/`ApiDispatcher`, which
 *           reaches `readTaskBoardFleet` in `packages/daemon/src/lib/task-boards/fleet-read.ts`.
 *
 * The AFTER path therefore carries routing, authorization and serialization overhead that the
 * BEFORE path does not. That is deliberate and it biases the result AGAINST the change: the ratio
 * printed is a floor, not a best case.
 *
 * SAFE AND OFFLINE. The fixture is `FakeTaskBoard` from the daemon's own unit-test support — an
 * in-memory board with an injected `Bun.sleep` standing in for the file read. Nothing here opens a
 * socket, reads a real state home, or touches `~/.ferretry`. It can be run on any checkout at any
 * time and answers only from what it just measured.
 */
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

function options(argv: readonly string[]): { boards: number; latency: number; samples: number } {
  const chosen = { ...DEFAULTS } as { boards: number; latency: number; samples: number };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]?.replace(/^--/u, '');
    const value = Number(argv[index + 1]);
    if (flag !== 'boards' && flag !== 'latency' && flag !== 'samples') {
      console.error(`❌ usage: bun scripts/local/bench-fleet-task-reads.ts [--boards N] [--latency MS] [--samples N]`);
      process.exit(2);
    }
    if (!Number.isFinite(value) || value < 0) {
      console.error(`❌ --${flag} needs a non-negative number, got ${String(argv[index + 1])}`);
      process.exit(2);
    }
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
 * Rebuilt for every sample so no arm can benefit from a warm one.
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

/** The shipped route, through the real router and dispatcher. */
async function routedFleetRead(subsystem: TaskSubsystem): Promise<number> {
  const dispatch = new ApiDispatcher(new ApiRouter(taskRoutes(subsystem)), CREDENTIALS);
  const response = await dispatch.dispatch(request({ path: '/v1/tasks', headers: human }));
  if (response.status !== 200) throw new Error(`the aggregate route answered ${response.status}, not 200`);
  return response.status;
}

async function samplesOf(
  runs: number,
  boards: number,
  latency: number,
  arm: (subsystem: TaskSubsystem) => Promise<number>,
): Promise<number[]> {
  const timings: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    const { subsystem } = fleet(boards, latency);
    const started = performance.now();
    await arm(subsystem);
    timings.push(performance.now() - started);
  }
  return timings;
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
console.log(`│ samples      ${samples} per arm, fixture rebuilt before each`);
console.log(`│ measured at  ${head()}${dirty() ? ' (WORKING TREE DIRTY — not a citable run)' : ''}`);
console.log(`│ reference    ${REFERENCE_COMMIT} ${REFERENCE_SUBJECT}`);
console.log('╰────────────────────────────────────────────────────────────────────────────');

const before = await samplesOf(samples, boards, latency, sequentialFleetRead);
const after = await samplesOf(samples, boards, latency, routedFleetRead);

console.log('');
const beforeMedian = report('BEFORE  sequential per-board await', before);
const afterMedian = report('AFTER   real route, bounded fan-out', after);
console.log('');
console.log(`  ratio ${(beforeMedian / afterMedian).toFixed(1)}× faster`);
console.log(`  the BEFORE arm pays no routing, authorization or serialization cost and the AFTER arm`);
console.log(`  pays all three, so this ratio is a floor.`);
