import { describe, it } from 'bun:test';
import { fixedClock } from '@ferretry/kernel/testing';
import { milliseconds } from '@ferretry/std';
import should from 'should';
import { type Card, type PrLink, UNFILED_PROJECT_ID } from '../../../contract/index.ts';
import { BoardService, NO_HELPERS } from '../../../daemon/lib/board/index.ts';
import {
  BOOT_REFILE_DELAY_MS,
  GITHUB_WATCH_JOB_ID,
  githubWatchJob,
  UNFILED_REFILE_JOB_ID,
  WATCH_FIRST_TICK_MS,
  WATCH_TICK_MS,
  type WatchSleep,
} from '../../../daemon/lib/github/index.ts';
import { card, FakeLanes, lanes, MemoryBoardStore, NOW, OTHER_PROJECT, PROJECT, world } from '../board/support.ts';
import { prUrl, REPO } from './support.ts';

const merged: PrLink = {
  url: prUrl(985),
  number: 985,
  repo: REPO,
  state: 'merged',
  draft: false,
  checks: 'passing',
  mergedAt: '2026-10-30T09:00:00Z',
  mergeSha: 'a'.repeat(40),
  releasedIn: null,
  polledAt: NOW,
};

/** Lets every pending promise chain run. */
const flush = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0));
};

interface RigOptions {
  readonly cards?: readonly Card[];
  readonly random?: () => number;
  /** Runs as each tick reads the board. */
  readonly onTick?: () => void;
}

/** The watch as `build()` makes it, over the kernel's driven clock; each tick is seen as the watcher's board read. */
const rig = (options: RigOptions = {}) => {
  const clock = fixedClock(NOW);
  const store = new MemoryBoardStore(options.cards ?? []);
  const sets = new FakeLanes(
    new Map([
      [PROJECT, lanes(PROJECT)],
      [OTHER_PROJECT, lanes(OTHER_PROJECT, 'pr')],
      [UNFILED_PROJECT_ID, lanes(UNFILED_PROJECT_ID, 'quick')],
    ]),
  );
  const service = new BoardService(world({ store, lanes: sets }));
  const ticks: number[] = [];
  const hold: { until?: Promise<void> } = {};
  const warnings: string[] = [];
  const projects = { projects: async () => [{ id: PROJECT, name: 'Ferretry', path: '/p' }] as never };
  const copies = {
    repositoryOf: async (path: string) => (path === '/p' ? REPO : null),
    branchOf: async () => null,
  };
  const diagnostics = { warn: (message: string) => warnings.push(message) };
  const now = () => clock.now() as string;
  const watch = githubWatchJob({
    alerts: { mode: async () => undefined, send: async () => undefined, withheld: async () => undefined },
    surface: { snapshot: async () => await service.snapshot(), note: async () => undefined, machineId: () => 'm' },
    roster: async () => ({ held: new Set(), sessions: new Map() }),
    helpers: NO_HELPERS,
    refiler: {
      board: service,
      sessions: { boardOf: async () => null },
      lanes: { laneSet: async project => await sets.laneSet(project), propose: async () => null },
      projects,
      copies,
      clock: { now },
      diagnostics,
    },
    watcher: {
      board: {
        snapshot: async () => {
          ticks.push(clock.nowMs());
          options.onTick?.();
          if (hold.until !== undefined) await hold.until;
          return await service.snapshot();
        },
        recordPullRequests: async (id, update) => await service.recordPullRequests(id, update),
        act: async (id, request, caller) => await service.act(id, request, caller),
      },
      gh: { run: async () => ({ kind: 'ok', stdout: '{}' }) },
      copies,
      sessions: { cwdOf: async () => null },
      projects,
      transcripts: { tail: async () => ({ kind: 'unresolved' }) },
      version: '5.0.0',
    },
    clock: { now, random: options.random ?? (() => 0.5) },
    diagnostics,
  });
  const sleeps: number[] = [];
  let slept: (() => void) | undefined;
  /** The kernel clock's sleep, as `build()` hands it over, noting each wait as it starts. */
  const sleep: WatchSleep = async (ms, signal) => {
    sleeps.push(ms);
    slept?.();
    await clock.sleep(milliseconds(ms), signal);
  };
  const nextSleep = async (): Promise<void> =>
    await new Promise<void>(resolve => {
      slept = resolve;
    });
  return { clock, store, watch, jobs: watch.jobs(sleep), ticks, hold, sleeps, nextSleep, warnings };
};

describe('the GitHub watch job: its cadence', () => {
  it('J-0231 should tick first 20 s after start, then 30 s after each tick FINISHES, and stop when aborted', async () => {
    // Arrange
    const subject = rig();
    const start = subject.clock.nowMs();
    const controller = new AbortController();
    let waiting = subject.nextSleep();

    // Act / Assert: the first look waits WATCH_FIRST_TICK_MS.
    const running = subject.jobs.watch.run(controller.signal);
    await waiting;
    should(subject.sleeps).deepEqual([WATCH_FIRST_TICK_MS]);
    await subject.clock.advance(WATCH_FIRST_TICK_MS - 1);
    await flush();
    should(subject.ticks).be.empty();
    waiting = subject.nextSleep();
    await subject.clock.advance(1);
    await waiting;
    should(subject.ticks).deepEqual([start + 20_000]);
    should(subject.sleeps).deepEqual([20_000, 30_000]);

    // A slow tick: no wait starts, and no tick overlaps it, until it has finished.
    let release: () => void = () => undefined;
    subject.hold.until = new Promise<void>(resolve => {
      release = resolve;
    });
    await subject.clock.advance(WATCH_TICK_MS);
    await flush();
    should(subject.ticks).deepEqual([start + 20_000, start + 50_000]);
    await subject.clock.advance(45_000);
    await flush();
    should(subject.ticks).have.length(2);
    should(subject.sleeps).have.length(2);
    delete subject.hold.until;
    waiting = subject.nextSleep();
    release();
    await waiting;
    should(subject.sleeps).deepEqual([20_000, 30_000, 30_000]);
    await subject.clock.advance(WATCH_TICK_MS - 1);
    await flush();
    should(subject.ticks).have.length(2);
    waiting = subject.nextSleep();
    await subject.clock.advance(1);
    await waiting;
    should(subject.ticks.at(-1)).equal(start + 50_000 + 45_000 + 30_000);

    // Stopping ends the run while it waits; nothing ticks after.
    controller.abort();
    await running;
    await subject.clock.advance(10 * WATCH_TICK_MS);
    await flush();
    should(subject.ticks).have.length(3);
  });

  it('J-0231 should move each wait by at most 10% either way', async () => {
    // Arrange: the lowest and the highest draw, alternately.
    const draws = [0, 0.999_999_9, 0, 0.999_999_9];
    const subject = rig({ random: () => draws.shift() ?? 0.5 });
    const controller = new AbortController();
    const seen: number[] = [];
    const sleep: WatchSleep = async ms => {
      seen.push(ms);
      if (seen.length === 3) controller.abort();
    };

    // Act
    await subject.watch.jobs(sleep).watch.run(controller.signal);

    // Assert
    should(seen).deepEqual([18_000, 33_000, 27_000]);
    should(subject.ticks).have.length(2);
  });

  it('J-0231 should end the run when stopped mid-tick, starting no wait after it', async () => {
    // Arrange
    const controller = new AbortController();
    const subject = rig({ onTick: () => controller.abort() });
    const seen: number[] = [];
    const sleep: WatchSleep = async ms => {
      seen.push(ms);
    };

    // Act
    await subject.watch.jobs(sleep).watch.run(controller.signal);

    // Assert
    should(subject.ticks).have.length(1);
    should(seen).deepEqual([WATCH_FIRST_TICK_MS]);
  });

  it('J-0231 should fail the run when its wait fails while still running, so the kernel restarts it', async () => {
    const subject = rig();
    const sleep: WatchSleep = async () => {
      throw new Error('clock gone');
    };
    await should(subject.watch.jobs(sleep).watch.run(new AbortController().signal)).be.rejectedWith('clock gone');
  });

  it('J-0231 should be one long run the kernel starts once, the cadence being its own', () => {
    const { jobs } = rig();
    should(jobs.watch.id).equal(GITHUB_WATCH_JOB_ID);
    should(jobs.watch.schedule).deepEqual({ onceAfterStart: true });
  });
});

describe('the GitHub watch job: the Unfiled refile at start', () => {
  it('J-0080 should run once, a second after start, and refile an Unfiled card whose PR a project owns', async () => {
    // Arrange
    const subject = rig({
      cards: [
        card({
          projectId: UNFILED_PROJECT_ID,
          laneId: 'doing',
          workflow: 'quick',
          links: { prs: [merged], branch: null, commits: [], docs: [] },
        }),
      ],
    });
    should(subject.jobs.refile.id).equal(UNFILED_REFILE_JOB_ID);
    should(subject.jobs.refile.schedule).deepEqual({ onceAfterStart: true, delay: BOOT_REFILE_DELAY_MS });
    should(BOOT_REFILE_DELAY_MS).equal(1_000);

    // Act
    await subject.jobs.refile.run(new AbortController().signal);

    // Assert: refiled without a tick of the watch.
    should(subject.store.cards.get('F1' as never)?.projectId).equal(PROJECT);
    should(subject.ticks).be.empty();
  });
});
